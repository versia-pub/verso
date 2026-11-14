import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { batchesOf } from "../batches.ts";
import { checkForeignKeys, usesSqlite } from "../columns.ts";

/*
 * This migration has its own copy of the id encoding, and doesn't import `kernel/ids.ts`: a
 * migration must keep doing what it did when it was written, even after the ids change again.
 */

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const lowBits = 0xffffffn;

const uuidv7 = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const wholeUuidv7 = new RegExp(`^${uuidv7.source}$`);

/** Matches a value with a UUIDv7 in it, for `like`, where `_` is any one character. */
const uuidv7Like = "%________-____-7___-____-____________%";

/**
 * A 90-bit id from a UUIDv7: its 48-bit time, then its top 48 random bits. The time must fit in 42
 * bits, which holds until the year 2109. A later one fails the migration, since leaving the UUID
 * would break Versia's id limit.
 */
const idOf = (uuid: string): bigint => {
    const value = BigInt(`0x${uuid.replaceAll("-", "")}`);
    const time = value >> 80n;
    if (time >= 1n << 42n) throw new Error(`The id ${uuid} is dated after 2109`);

    const randomA = (value >> 64n) & 0xfffn;
    const randomB = value & ((1n << 62n) - 1n);

    return (time << 48n) | (randomA << 36n) | (randomB >> 26n);
};

const encode = (id: bigint): string => {
    let text = "";

    for (let i = 0; i < 18; i++) {
        text = alphabet[Number((id >> BigInt(5 * i)) & 31n)] + text;
    }

    return text;
};

type Column = { table: string; column: string; json: boolean };

const textColumns = async (db: Kysely<unknown>): Promise<Column[]> => {
    if (usesSqlite(db)) {
        // `pragma_table_list` leaves out the virtual tables of full-text search and their shadow tables.
        const { rows } = await sql<{ table: string; column: string; type: string }>`
            select t.name as "table", c.name as "column", lower(c.type) as type
            from pragma_table_list t, pragma_table_info(t.name) c
            where t.schema = 'main' and t.type = 'table'
                and t.name not like 'kysely!_%' escape '!' and t.name not like 'sqlite!_%' escape '!'
                and (lower(c.type) like '%text%' or lower(c.type) like '%json%')
                and lower(c.type) not like '%timestamp%'
            order by t.name, c.cid`.execute(db);

        return rows.map(({ table, column, type }) => ({
            table,
            column,
            json: type.includes("json"),
        }));
    }

    const { rows } = await sql<{ table: string; column: string; type: string }>`
        select c.table_name as "table", c.column_name as "column", c.data_type as type
        from information_schema.columns c
        join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
            and c.table_name not like 'kysely!_%' escape '!'
            and c.data_type in ('text', 'jsonb')
        order by c.table_name, c.ordinal_position`.execute(db);

    return rows.map(({ table, column, type }) => ({ table, column, json: type === "jsonb" }));
};

/** Every distinct value of the columns, which is a set so values in several are counted once. */
const valuesOf = async (db: Kysely<unknown>, columns: Column[]): Promise<Set<string>> => {
    const values = new Set<string>();

    for (const { table, column } of columns) {
        const { rows } = await sql<{ value: string }>`
            select distinct ${sql.id(column)} as value from ${sql.id(table)}
            where ${sql.id(column)} is not null`.execute(db);

        for (const { value } of rows) values.add(value);
    }

    return values;
};

/**
 * Local ids, in the order of the UUIDs. An id that another one already took changes in its low 24
 * bits until it is free.
 */
const localMap = (uuids: string[], taken: Set<string>): Map<string, string> => {
    const map = new Map<string, string>();

    for (const uuid of uuids.toSorted()) {
        let id = idOf(uuid);
        while (taken.has(encode(id))) id = (id & ~lowBits) | ((id + 1n) & lowBits);

        const text = encode(id);
        taken.add(text);
        map.set(uuid, text);
    }

    return map;
};

/** Remote ids, which come from the UUID alone, so that peers that ran this agree on them. */
const remoteMap = (uuids: string[]): Map<string, string> => {
    const map = new Map<string, string>();

    for (const uuid of uuids) map.set(uuid, encode(idOf(uuid)));

    return map;
};

const createMap = async (
    db: Kysely<unknown>,
    name: string,
    map: Map<string, string>,
): Promise<void> => {
    await sql`create temporary table ${sql.id(name)} (old text primary key, new text not null)`
        .execute(db);

    for (const batch of batchesOf([...map])) {
        await sql`insert into ${sql.id(name)} (old, new)
            values ${sql.join(batch.map(([old, id]) => sql`(${old}, ${id})`))}`.execute(db);
    }
};

/** The foreign keys, to make deferrable for the update and put back after it. */
const foreignKeys = async (db: Kysely<unknown>): Promise<{ table: string; name: string }[]> => {
    const { rows } = await sql<{ table: string; name: string }>`
        select c.relname as "table", k.conname as name
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where k.contype = 'f' and n.nspname = current_schema()
        order by c.relname, k.conname`.execute(db);

    return rows;
};

const setDeferrable = async (
    db: Kysely<unknown>,
    keys: { table: string; name: string }[],
    mode: "deferrable initially deferred" | "not deferrable",
): Promise<void> => {
    for (const { table, name } of keys) {
        await sql`alter table ${sql.id(table)} alter constraint ${sql.id(name)} ${sql.raw(mode)}`
            .execute(db);
    }
};

/**
 * Rewrites every id from a UUIDv7 into an id of 18 characters, since Versia v0.7 limits ids to 18
 * characters of `[a-z0-9_-]`. An id keeps its time from the UUIDv7, so ids still sort by creation
 * time, and it takes the first 48 random bits, as the node and the counter. See `kernel/ids.ts`.
 *
 * It finds the text and JSON columns in the schema, so no column is missed. Every UUIDv7 in an `id`
 * column becomes a new id, and so does each one in a column that holds one exactly, like
 * `in_reply_to_id`. Ids in longer values, like job payloads, keys, and links in content, are
 * replaced where they are. Two UUIDv7 that differ only after the first 48 random bits would get the
 * same id, so the second one's counter is moved up until the id is free.
 *
 * The ids of remote accounts and notes (`remote_id` and `previous_id`) are not fixed that way. They
 * come from the UUIDv7 alone, so they are the ids a Verso peer gives the same objects when it runs
 * this migration, and the two agree on them.
 *
 * On Postgres the foreign keys are deferred while the ids change, then checked. On SQLite they are
 * off while migrating, so the migration checks them at the end.
 */
export const versiaIds: Migration = {
    up: async (db: Kysely<unknown>) => {
        const sqlite = usesSqlite(db);
        const columns = await textColumns(db);
        const remoteColumns = columns.filter(({ column }) =>
            column === "remote_id" || column === "previous_id"
        );

        const local = new Set<string>();
        const taken = new Set<string>();
        for (const value of await valuesOf(db, columns.filter(({ column }) => column === "id"))) {
            (wholeUuidv7.test(value) ? local : taken).add(value);
        }

        const locals = localMap([...local], taken);
        const remotes = remoteMap(
            [...await valuesOf(db, remoteColumns)].filter((value) => wholeUuidv7.test(value)),
        );

        const keys = sqlite ? [] : await foreignKeys(db);
        if (!sqlite) {
            await setDeferrable(db, keys, "deferrable initially deferred");
            await sql`set constraints all deferred`.execute(db);
        }

        await createMap(db, "local_id_map", locals);
        await createMap(db, "remote_id_map", remotes);

        for (const { table, column, json } of columns) {
            if (json) continue;

            const map = remoteColumns.some((remote) =>
                    remote.table === table && remote.column === column
                )
                ? "remote_id_map"
                : "local_id_map";

            await sql`update ${sql.id(table)}
                set ${sql.id(column)} = (
                    select new from ${sql.id(map)} where old = ${sql.id(table, column)}
                )
                where ${sql.id(column)} in (select old from ${sql.id(map)})`.execute(db);
        }

        // Tables differ in their keys, so rows are found by `rowid` on SQLite and `ctid` on Postgres.
        for (const { table, column, json } of columns) {
            const { rows } = await sql<{ locator: string; value: string }>`
                select ${sqlite ? sql`rowid` : sql`cast(ctid as text)`} as locator,
                    cast(${sql.id(column)} as text) as value
                from ${sql.id(table)}
                where cast(${sql.id(column)} as text) like ${uuidv7Like}`.execute(db);

            // JSON stays JSON on Postgres. SQLite stores both as text.
            const type = sql.raw(sqlite || !json ? "text" : "jsonb");
            for (const { locator, value } of rows) {
                const replaced = value.replace(uuidv7, (uuid) => locals.get(uuid) ?? uuid);
                if (replaced === value) continue;

                await sql`update ${sql.id(table)}
                    set ${sql.id(column)} = cast(${replaced} as ${type})
                    where ${sqlite ? sql`rowid` : sql`ctid`} =
                        ${sqlite ? locator : sql`cast(${locator} as tid)`}`.execute(db);
            }
        }

        await sql`drop table ${sql.id("local_id_map")}`.execute(db);
        await sql`drop table ${sql.id("remote_id_map")}`.execute(db);

        if (sqlite) {
            await checkForeignKeys(db);
        } else {
            await sql`set constraints all immediate`.execute(db);
            await setDeferrable(db, keys, "not deferrable");
        }
    },
};
