import { type Expression, sql, type SqlBool } from "kysely";
import { usesSqlite } from "../db/columns.ts";
import type { Context } from "../kernel/context.ts";

/** A search index: its table, the FTS5 table SQLite keeps its words in, and what it indexes. */
type Index = { readonly table: string; readonly text: string; readonly key: string };

const notes: Index = { table: "note_search", text: "note_search_text", key: "note_id" };

const accounts: Index = { table: "account_search", text: "account_search_text", key: "account_id" };

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
): Promise<void> => indexWords(ctx, notes, noteId, words);

/** Keeps `words` as the words of `accountId`, replacing those it had. */
export const indexAccount = (
    ctx: Pick<Context, "db">,
    accountId: string,
    words: readonly string[],
): Promise<void> => indexWords(ctx, accounts, accountId, words);

/**
 * Whether the id in `column` is of something in `index` with words that start with each of
 * `words`, which there must be some of. Words are only letters and digits, so they never carry
 * query syntax.
 */
const matching = (
    ctx: Pick<Context, "db">,
    index: Index,
    column: string,
    words: readonly string[],
): Expression<SqlBool> => {
    const table = sql.table(index.table);
    const key = sql.ref(index.key);

    if (!usesSqlite(ctx.db)) {
        const query = words.map((word) => `${word}:*`).join(" & ");
        return sql<SqlBool>`${sql.ref(column)} IN (
            SELECT ${key} FROM ${table} WHERE document @@ to_tsquery('simple', ${query})
        )`;
    }

    const kept = sql.table(index.text);
    const query = words.map((word) => `"${word}"*`).join(" ");
    return sql<SqlBool>`${sql.ref(column)} IN (
        SELECT ${key} FROM ${table} WHERE id IN (SELECT rowid FROM ${kept} WHERE ${kept} MATCH ${query})
    )`;
};

/** Up to `limit` statuses that aren't indexed yet, other than boosts, which have no words. */
export const unindexedNoteIds = async (
    ctx: Pick<Context, "db">,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("notes")
        .leftJoin("note_search", "note_search.note_id", "notes.id")
        .select("notes.id")
        .where("note_search.note_id", "is", null)
        .where("notes.reblog_of_id", "is", null)
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};

/** Up to `limit` accounts that aren't indexed yet. */
export const unindexedAccountIds = async (
    ctx: Pick<Context, "db">,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("accounts")
        .leftJoin("account_search", "account_search.account_id", "accounts.id")
        .select("accounts.id")
        .where("account_search.account_id", "is", null)
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};

/**
 * Up to `limit` statuses, newest first, with words that start with each of `words`. No words find
 * nothing.
 */
export const noteIdsMatching = async (
    ctx: Pick<Context, "db">,
    words: readonly string[],
    limit: number,
): Promise<string[]> => {
    if (words.length === 0) return [];

    const rows = await ctx.db.selectFrom("notes")
        .select("id")
        .where(matching(ctx, notes, "notes.id", words))
        .orderBy("id", "desc")
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};

/** What accounts to find, besides their words. */
export type AccountMatch = {
    /** Who is searching, if anyone is signed in. */
    readonly viewerId: string | null;
    /** Whether to find only the viewer and the accounts they follow. */
    readonly following: boolean;
    readonly limit: number;
    readonly offset: number;
};

/**
 * Accounts with words that start with each of `words`, as Mastodon orders them: those the viewer
 * follows or is followed by first, then those with the most followers. No words find nothing.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/concerns/account/search.rb
 */
export const accountIdsMatching = async (
    ctx: Pick<Context, "db">,
    words: readonly string[],
    match: AccountMatch,
): Promise<string[]> => {
    const { viewerId } = match;
    if (words.length === 0) return [];

    let query = ctx.db.selectFrom("accounts")
        .select("accounts.id")
        .where(matching(ctx, accounts, "accounts.id", words));
    if (viewerId !== null) {
        if (match.following) {
            query = query.where((eb) =>
                eb.or([
                    eb("accounts.id", "=", viewerId),
                    eb(
                        "accounts.id",
                        "in",
                        eb.selectFrom("follows")
                            .select("followee_id")
                            .where("follower_id", "=", viewerId)
                            .where("accepted", "=", true),
                    ),
                ])
            );
        }

        query = query.orderBy(
            (eb) =>
                eb.selectFrom("follows")
                    .select((count) => count.fn.countAll().as("count"))
                    .where("accepted", "=", true)
                    .where((follows) =>
                        follows.or([
                            follows.and([
                                follows("follower_id", "=", viewerId),
                                follows("followee_id", "=", follows.ref("accounts.id")),
                            ]),
                            follows.and([
                                follows("follower_id", "=", follows.ref("accounts.id")),
                                follows("followee_id", "=", viewerId),
                            ]),
                        ])
                    ),
            "desc",
        );
    }

    const rows = await query
        .orderBy("accounts.followers_count", "desc")
        .orderBy("accounts.id")
        .limit(match.limit)
        .offset(match.offset)
        .execute();

    return rows.map((row) => row.id);
};
