/**
 * The search indexes: the words of statuses and of accounts, as Postgres's full-text search and
 * SQLite's FTS5 keep them, and how words are matched against them.
 * @module
 */
import { type Expression, sql, type SqlBool } from "kysely";
import { usesSqlite } from "../db/columns.ts";
import type { Context } from "../kernel/context.ts";

/** A search index: its table, the FTS5 table SQLite keeps its words in, and what it indexes. */
export type Index = { readonly table: string; readonly text: string; readonly key: string };

/** The words of statuses. */
export const noteIndex: Index = { table: "note_search", text: "note_search_text", key: "note_id" };

/** The words of accounts' names and domains. */
export const accountIndex: Index = {
    table: "account_search",
    text: "account_search_text",
    key: "account_id",
};

/**
 * Keeps `words` as the words of `id` in `index`, replacing those it had. On SQLite, its row gives
 * the rowid its words are kept under.
 */
const indexWords = async (
    ctx: Pick<Context, "db">,
    index: Index,
    id: string,
    words: readonly string[],
) => {
    const text = words.join(" ");
    const table = sql.table(index.table);
    const key = sql.ref(index.key);

    if (!usesSqlite(ctx.db)) {
        await sql`
            INSERT INTO ${table} (${key}, document) VALUES (${id}, to_tsvector('simple', ${text}))
            ON CONFLICT (${key}) DO UPDATE SET document = excluded.document
        `.execute(ctx.db);
        return;
    }

    // Updated in place on a conflict, so that it returns its id either way.
    const { rows: [{ id: rowid }] } = await sql<{ id: number }>`
        INSERT INTO ${table} (${key}) VALUES (${id})
        ON CONFLICT (${key}) DO UPDATE SET ${key} = excluded.${key}
        RETURNING id
    `.execute(ctx.db);
    const kept = sql.table(index.text);
    await sql`DELETE FROM ${kept} WHERE rowid = ${rowid}`.execute(ctx.db);
    await sql`INSERT INTO ${kept} (rowid, text) VALUES (${rowid}, ${text})`.execute(ctx.db);
};

/** Keeps `words` as the words of `noteId`, replacing those it had. */
export const indexNote = (
    ctx: Pick<Context, "db">,
    noteId: string,
    words: readonly string[],
): Promise<void> => indexWords(ctx, noteIndex, noteId, words);

/** Keeps `words` as the words of `accountId`, replacing those it had. */
export const indexAccount = (
    ctx: Pick<Context, "db">,
    accountId: string,
    words: readonly string[],
): Promise<void> => indexWords(ctx, accountIndex, accountId, words);

/**
 * The shortest word matched as the start of words. A shorter one is matched only as a whole word,
 * since one letter starts most of them.
 */
const minPrefixLength = 2;

/**
 * Whether the id in `column` is of something in `index` with words that start with each of
 * `words`, or are those that are too short to be prefixes, which there must be some of, or with
 * `phrase`, that are `words` one after another. Words are only letters and digits, so they never
 * carry query syntax.
 */
export const matching = (
    ctx: Pick<Context, "db">,
    index: Index,
    column: string,
    words: readonly string[],
    phrase = false,
): Expression<SqlBool> => {
    const table = sql.table(index.table);
    const key = sql.ref(index.key);

    const isPrefix = (word: string) => Array.from(word).length >= minPrefixLength;

    if (!usesSqlite(ctx.db)) {
        const query = phrase
            ? words.join(" <-> ")
            : words.map((word) => isPrefix(word) ? `${word}:*` : word).join(" & ");
        return sql<SqlBool>`${sql.ref(column)} IN (
            SELECT ${key} FROM ${table} WHERE document @@ to_tsquery('simple', ${query})
        )`;
    }

    const kept = sql.table(index.text);
    const query = phrase
        ? `"${words.join(" ")}"`
        : words.map((word) => isPrefix(word) ? `"${word}"*` : `"${word}"`).join(" ");
    return sql<SqlBool>`${sql.ref(column)} IN (
        SELECT ${key} FROM ${table} WHERE id IN (SELECT rowid FROM ${kept} WHERE ${kept} MATCH ${query})
    )`;
};

/**
 * Up to `limit` statuses after `after`, in id order, that aren't indexed yet, other than boosts,
 * which have no words. Paging by id means each batch starts where the last ended, rather than
 * passing every status indexed before it again.
 */
export const unindexedNoteIds = async (
    ctx: Pick<Context, "db">,
    after: string | null,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("notes")
        .leftJoin("note_search", "note_search.note_id", "notes.id")
        .select("notes.id")
        .where("note_search.note_id", "is", null)
        .where("notes.reblog_of_id", "is", null)
        .$if(after !== null, (query) => query.where("notes.id", ">", after ?? ""))
        .orderBy("notes.id")
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};

/** Up to `limit` accounts after `after`, in id order, that aren't indexed yet, as statuses are. */
export const unindexedAccountIds = async (
    ctx: Pick<Context, "db">,
    after: string | null,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("accounts")
        .leftJoin("account_search", "account_search.account_id", "accounts.id")
        .select("accounts.id")
        .where("account_search.account_id", "is", null)
        .$if(after !== null, (query) => query.where("accounts.id", ">", after ?? ""))
        .orderBy("accounts.id")
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};
