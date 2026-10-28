import { type Expression, type ExpressionBuilder, sql, type SqlBool } from "kysely";
import type { Database } from "../db/database.ts";
import { usesSqlite } from "../db/columns.ts";
import { type Excluded, notExcluded } from "../graph/excluded_queries.ts";
import { hasAttachments } from "../media/attachment_queries.ts";
import type { Context } from "../kernel/context.ts";
import { isSeenBy, type Onlooker } from "../notes/thread_queries.ts";

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
 * `words`, which there must be some of, or with `phrase`, that are `words` one after another.
 * Words are only letters and digits, so they never carry query syntax.
 */
const matching = (
    ctx: Pick<Context, "db">,
    index: Index,
    column: string,
    words: readonly string[],
    phrase = false,
): Expression<SqlBool> => {
    const table = sql.table(index.table);
    const key = sql.ref(index.key);

    if (!usesSqlite(ctx.db)) {
        const query = phrase ? words.join(" <-> ") : words.map((word) => `${word}:*`).join(" & ");
        return sql<SqlBool>`${sql.ref(column)} IN (
            SELECT ${key} FROM ${table} WHERE document @@ to_tsquery('simple', ${query})
        )`;
    }

    const kept = sql.table(index.text);
    const query = phrase ? `"${words.join(" ")}"` : words.map((word) => `"${word}"*`).join(" ");
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

/**
 * What a status must have to be found, or with `negated`, mustn't: words that start with each of
 * `values`, those words one after another as a phrase, or a hashtag, named by its one value; an
 * author, if there is one by the name the query gave; a property Mastodon searches; a language; or
 * a time it was created at or after `since`, and before `until`.
 */
export type NoteTerm =
    & { readonly negated: boolean }
    & (
        | { readonly kind: "words" | "phrase" | "hashtag"; readonly values: readonly string[] }
        | { readonly kind: "author"; readonly accountId: string | null }
        | { readonly kind: "property"; readonly property: string }
        | { readonly kind: "language"; readonly language: string }
        | { readonly kind: "created"; readonly since: Date | null; readonly until: Date | null }
    );

/** Matches nothing, for what no status has. */
const never = sql<SqlBool>`1 = 0`;

/**
 * Whether a status has `property`, as Mastodon's search names them. Verso's media are images, and
 * it has no polls or link previews, so a status never has the others.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/concerns/status/search_concern.rb
 */
const hasProperty = (property: string) => (eb: ExpressionBuilder<Database, "notes">) => {
    if (property === "media" || property === "image") return hasAttachments(eb);
    if (property === "sensitive") return eb("notes.sensitive", "=", true);
    if (property === "reply") return eb("notes.in_reply_to_id", "is not", null);
    return never;
};

/**
 * Whether a status has what `term` says, not counting whether it is negated. It is never unknown,
 * so that negating it finds the statuses without it.
 */
const has = (ctx: Context, term: NoteTerm) => (eb: ExpressionBuilder<Database, "notes">) => {
    switch (term.kind) {
        case "words":
        case "phrase":
            return matching(ctx, notes, "notes.id", term.values, term.kind === "phrase");
        case "hashtag":
            return eb.exists(
                eb.selectFrom("note_tags").select("note_tags.note_id")
                    .whereRef("note_tags.note_id", "=", "notes.id")
                    .where("note_tags.name", "=", term.values[0]),
            );
        case "author":
            return term.accountId === null ? never : eb("notes.account_id", "=", term.accountId);
        case "property":
            return hasProperty(term.property)(eb);
        case "language":
            return eb.and([
                eb("notes.language", "is not", null),
                eb("notes.language", "=", term.language),
            ]);
        case "created":
            return eb.and([
                ...term.since === null ? [] : [eb("notes.created_at", ">=", term.since)],
                ...term.until === null ? [] : [eb("notes.created_at", "<", term.until)],
            ]);
    }
};

/**
 * Which of the statuses Mastodon searches to search: those whose authors chose to be found, those
 * the viewer took part in, which Mastodon calls their library, or all of them.
 */
export type NoteScope = "public" | "library" | "all";

/** Whether a status is public, by an author who chose to be found. */
const findable = (eb: ExpressionBuilder<Database, "notes">) =>
    eb.and([
        eb("notes.visibility", "=", "public"),
        eb.exists(
            eb.selectFrom("accounts").select("accounts.id")
                .whereRef("accounts.id", "=", "notes.account_id")
                .where("accounts.indexable", "=", true),
        ),
    ]);

/** Whether `viewerId` wrote a status, was mentioned in it, liked it or boosted it. */
const inLibraryOf = (viewerId: string) => (eb: ExpressionBuilder<Database, "notes">) =>
    eb.or([
        eb("notes.account_id", "=", viewerId),
        eb.exists(
            eb.selectFrom("note_mentions").select("note_mentions.note_id")
                .whereRef("note_mentions.note_id", "=", "notes.id")
                .where("note_mentions.account_id", "=", viewerId),
        ),
        eb.exists(
            eb.selectFrom("likes").select("likes.id")
                .whereRef("likes.note_id", "=", "notes.id")
                // Local users, who alone search, never dislike statuses.
                .where("likes.account_id", "=", viewerId),
        ),
        eb.exists(
            eb.selectFrom("notes as shares").select("shares.id")
                .whereRef("shares.reblog_of_id", "=", "notes.id")
                .where("shares.account_id", "=", viewerId),
        ),
    ]);

/** What statuses to find, besides their words. */
export type NoteMatch = {
    /** Who is searching. */
    readonly onlooker: Exclude<Onlooker, null>;
    /** The accounts the viewer blocks or mutes. */
    readonly hidden: Excluded;
    /** Which statuses to search, if the query says. */
    readonly scope: NoteScope | null;
    /** The author to find statuses of, if only one's. */
    readonly accountId: string | null;
    /** The id statuses must be newer than, if any. */
    readonly minId: string | null;
    /** The id statuses must be older than, if any. */
    readonly maxId: string | null;
    readonly limit: number;
    readonly offset: number;
};

/**
 * Statuses, newest first, with what each of `terms` says, of those Mastodon searches in `scope`:
 * public statuses whose authors are `indexable`, and those the viewer wrote, was mentioned in,
 * liked or boosted. Of those, only the ones the viewer may see, by authors they don't block or
 * mute, are found, and never boosts. No terms, without a scope, find nothing.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/statuses_search_service.rb
 */
export const noteIdsMatching = async (
    ctx: Context,
    terms: readonly NoteTerm[],
    match: NoteMatch,
): Promise<string[]> => {
    const viewerId = match.onlooker.id;
    if (terms.length === 0 && match.scope === null) return [];

    let query = ctx.db.selectFrom("notes")
        .select("notes.id")
        // Boosts aren't statuses of their own to find, as on Mastodon.
        .where("notes.reblog_of_id", "is", null)
        .where((eb) =>
            eb.and(
                terms.map((term) => term.negated ? eb.not(has(ctx, term)(eb)) : has(ctx, term)(eb)),
            )
        )
        .where((eb) => {
            if (match.scope === "public") return findable(eb);
            if (match.scope === "library") return inLibraryOf(viewerId)(eb);
            return eb.or([findable(eb), inLibraryOf(viewerId)(eb)]);
        })
        .where(isSeenBy(ctx, match.onlooker, "notes.id"))
        .where(notExcluded(match.hidden, "notes.account_id"));
    if (match.accountId !== null) query = query.where("notes.account_id", "=", match.accountId);
    if (match.minId !== null) query = query.where("notes.id", ">", match.minId);
    if (match.maxId !== null) query = query.where("notes.id", "<", match.maxId);

    const rows = await query
        .orderBy("notes.id", "desc")
        .limit(match.limit)
        .offset(match.offset)
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

        // 1 for each way the viewer and the account follow each other. The sets are each looked up
        // once, rather than counted again for every account that matches.
        const followed = ctx.db.selectFrom("follows").select("followee_id")
            .where("follower_id", "=", viewerId).where("accepted", "=", true);
        const following = ctx.db.selectFrom("follows").select("follower_id")
            .where("followee_id", "=", viewerId).where("accepted", "=", true);
        query = query.orderBy(
            (eb) =>
                eb(
                    eb.case().when("accounts.id", "in", followed).then(1).else(0).end(),
                    "+",
                    eb.case().when("accounts.id", "in", following).then(1).else(0).end(),
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

/**
 * Up to `limit` hashtags, after the first `offset`, that start with `start` and are used by a
 * public or unlisted status, shortest first, as Mastodon lists them. Hashtags used only where few
 * can see them stay unknown.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/tag.rb
 */
export const hashtagsStartingWith = async (
    ctx: Pick<Context, "db">,
    start: string,
    limit: number,
    offset: number,
): Promise<string[]> => {
    // `_` is common in hashtags, and mustn't match any character.
    const pattern = `${start.replaceAll(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const rows = await ctx.db.selectFrom("note_tags")
        .innerJoin("notes", "notes.id", "note_tags.note_id")
        .select("note_tags.name")
        .where(sql<SqlBool>`note_tags.name LIKE ${pattern} ESCAPE '\\'`)
        .where("notes.visibility", "in", ["public", "unlisted"])
        .groupBy("note_tags.name")
        .orderBy(sql`length(note_tags.name)`)
        .orderBy("note_tags.name")
        .limit(limit)
        .offset(offset)
        .execute();

    return rows.map((row) => row.name);
};

/** How many statuses used a hashtag on one of the days asked about, and how many accounts. */
export type HashtagDay = {
    readonly name: string;
    /** Which of the days. */
    readonly day: number;
    readonly uses: number;
    readonly accounts: number;
};

/**
 * How public and unlisted statuses used each of `names` on each of the days that start at `days`,
 * newest first, each a day long, as Mastodon counts its uses. Days they weren't used are left out.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/trends/tags.rb
 */
export const hashtagUses = async (
    ctx: Pick<Context, "db">,
    names: readonly string[],
    days: readonly Date[],
): Promise<HashtagDay[]> => {
    const newest = days.at(0);
    const oldest = days.at(-1);
    if (names.length === 0 || newest === undefined || oldest === undefined) return [];

    // Which of `days` a status is from, by the newest it is after.
    const day = sql<number>`CASE ${
        sql.join(
            days.map((start, i) => sql`WHEN notes.created_at >= ${start} THEN ${sql.lit(i)}`),
            sql` `,
        )
    } END`;
    const rows = await ctx.db.selectFrom("note_tags")
        .innerJoin("notes", "notes.id", "note_tags.note_id")
        .select((eb) => [
            "note_tags.name",
            day.as("day"),
            eb.fn.countAll<number | string | bigint>().as("uses"),
            eb.fn.count<number | string | bigint>("notes.account_id").distinct().as("accounts"),
        ])
        .where("note_tags.name", "in", names)
        .where("notes.visibility", "in", ["public", "unlisted"])
        .where("notes.created_at", ">=", oldest)
        .where("notes.created_at", "<", new Date(newest.getTime() + 24 * 60 * 60 * 1000))
        .groupBy(["note_tags.name", sql`day`])
        .execute();

    return rows.map((row) => ({
        name: row.name,
        day: Number(row.day),
        uses: Number(row.uses),
        accounts: Number(row.accounts),
    }));
};
