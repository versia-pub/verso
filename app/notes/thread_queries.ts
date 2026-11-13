import type { Visibility } from "../kernel/visibility.ts";
import { countAll, readCount } from "../db/count.ts";
import type { Database } from "../db/database.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import { type ExpressionBuilder, type ExpressionWrapper, sql, type SqlBool } from "kysely";
import { type Excluded, type Filter, notExcluded } from "../graph/excluded_queries.ts";
import { type PageBounds, readPage } from "../db/paging.ts";

/**
 * Someone viewing statuses, with the accounts they follow and the accounts that block them, or
 * `null` for anyone.
 */
export type Onlooker = {
    readonly id: string;
    readonly followed: AccountIdQuery;
    readonly blockers: AccountIdQuery;
} | null;

/**
 * Whether `onlooker` may see a status, by the rules of `canSee` in `visibility.ts`, as a query
 * condition. It looks at one row; `visibility.ts` also checks the status a boost boosts.
 */
const seenBy = (onlooker: Onlooker) => (eb: ExpressionBuilder<Database, "notes">) => {
    const unsuspended = eb.not(eb.exists(
        eb.selectFrom("accounts").select("accounts.id")
            .whereRef("accounts.id", "=", "notes.account_id")
            .where("accounts.suspended_at", "is not", null),
    ));
    const listed = eb("notes.visibility", "in", ["public", "unlisted"]);
    if (onlooker === null) return eb.and([unsuspended, listed]);

    return eb.and([
        unsuspended,
        eb.or([
            listed,
            eb("notes.account_id", "=", onlooker.id),
            eb.and([
                eb("notes.visibility", "=", "private"),
                eb("notes.account_id", "in", onlooker.followed),
                eb("notes.account_id", "not in", onlooker.blockers),
            ]),
            eb.exists(
                eb.selectFrom("note_mentions").select("note_mentions.note_id")
                    .whereRef("note_mentions.note_id", "=", "notes.id")
                    .where("note_mentions.account_id", "=", onlooker.id),
            ),
        ]),
    ]);
};

/**
 * Whether a status is shown to `onlooker` despite its author being silenced: it isn't, or they are
 * the author, or follow them, as Mastodon's status filter decides for threads, status search and
 * quotes. A follow request isn't enough.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/lib/status_filter.rb
 */
const unsilencedFor = (onlooker: Onlooker) => (eb: ExpressionBuilder<Database, "notes">) => {
    const unsilenced = eb.not(eb.exists(
        eb.selectFrom("accounts").select("accounts.id")
            .whereRef("accounts.id", "=", "notes.account_id")
            .where("accounts.silenced_at", "is not", null),
    ));
    if (onlooker === null) return unsilenced;

    return eb.or([
        unsilenced,
        eb("notes.account_id", "=", onlooker.id),
        eb("notes.account_id", "in", onlooker.followed),
    ]);
};

/**
 * Whether `onlooker` may see a status in `notes` and is shown it despite a silenced author, as
 * threads and status search show statuses.
 */
export const shownTo = (
    onlooker: Onlooker,
): (eb: ExpressionBuilder<Database, "notes">) => ExpressionWrapper<Database, "notes", SqlBool> =>
(eb) => eb.and([seenBy(onlooker)(eb), unsilencedFor(onlooker)(eb)]);

/** Which of `ids` are statuses `onlooker` may see and is shown despite silenced authors. */
export const notesShownTo = async (
    ctx: Context,
    ids: readonly string[],
    onlooker: Onlooker,
): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("notes").select("id")
        .where("id", "in", ids)
        .where(shownTo(onlooker))
        .execute();

    return new Set(rows.map((row) => row.id));
};

/**
 * Whether the status whose id is in `column`, such as `notifications.note_id`, is one `onlooker`
 * may see, for another module's query.
 */
export const isSeenBy = (ctx: Context, onlooker: Onlooker, column: string): Filter => (eb) =>
    eb.exists(
        ctx.db.selectFrom("notes").select("notes.id")
            .where("notes.id", "=", sql.ref<string>(column))
            .where(seenBy(onlooker)),
    );

/** Which of `ids` are statuses `onlooker` may see, in no particular order. */
export const notesSeenBy = async (
    ctx: Context,
    ids: readonly string[],
    onlooker: Onlooker,
): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("notes").select("id")
        .where("id", "in", ids)
        .where(seenBy(onlooker))
        .execute();

    return new Set(rows.map((row) => row.id));
};

/**
 * The replies to any of `noteIds`, oldest first, at most `limit`, with whether `onlooker` may see
 * each and is shown it despite a silenced author.
 */
export const repliesTo = async (
    ctx: Context,
    noteIds: readonly string[],
    onlooker: Onlooker,
    limit: number,
): Promise<{ note: NoteRow; seen: boolean }[]> => {
    if (noteIds.length === 0) return [];

    const rows = await ctx.db.selectFrom("notes").selectAll()
        .select((eb) => shownTo(onlooker)(eb).as("seen"))
        .where("in_reply_to_id", "in", noteIds)
        .orderBy("id")
        .limit(limit)
        .execute();

    // SQLite returns 1 or 0.
    return rows.map(({ seen, ...note }) => ({ note, seen: Boolean(seen) }));
};

/** How a status links to another: by replying to it, or quoting it. */
export type NoteLink = "in_reply_to_id" | "quote_id";

/** The statuses with one of `visibilities` that link to `noteId` by `link`. */
const linkedTo = (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
) => ctx.db.selectFrom("notes")
    .where(link, "=", noteId)
    .where("visibility", "in", visibilities)
    .where("reblog_of_id", "is", null);

/** The ids of the statuses linking to `noteId`, as {@link linkedTo} finds them, oldest first. */
export const linkedNoteIds = async (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await linkedTo(ctx, link, noteId, visibilities).select("id")
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.id);

/** How many statuses link to `noteId`, as {@link linkedTo} finds them. */
export const countLinkedNotes = async (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await linkedTo(ctx, link, noteId, visibilities).select(countAll).executeTakeFirstOrThrow(),
    );

/**
 * How many statuses with one of `visibilities` quote each of `noteIds`, by status, omitting those
 * nothing quotes. Boosts aren't quotes.
 */
export const quoteCounts = async (
    ctx: Context,
    noteIds: readonly string[],
    visibilities: readonly Visibility[],
): Promise<Map<string, number>> => {
    if (noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("notes")
        .select((eb) => ["quote_id", countAll(eb)])
        .where("quote_id", "in", noteIds)
        .where("visibility", "in", visibilities)
        .where("reblog_of_id", "is", null)
        .groupBy("quote_id")
        .execute();

    return new Map(
        rows.flatMap((row) => row.quote_id === null ? [] : [[row.quote_id, readCount(row)]]),
    );
};

/**
 * A page of the statuses with one of `visibilities` that quote `noteId`, excluding those by the
 * accounts `hidden`, and those by silenced accounts unless `silencedFor` is shown them, newest
 * first. Boosts aren't quotes.
 */
export const quotePage = async (
    ctx: Context,
    noteId: string,
    visibilities: readonly Visibility[],
    hidden: Excluded | null,
    silencedFor: { readonly onlooker: Onlooker } | null,
    page: PageBounds,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("notes").selectAll()
        .where("quote_id", "=", noteId)
        .where("visibility", "in", visibilities)
        .where("reblog_of_id", "is", null);
    if (hidden !== null) query = query.where(notExcluded(hidden, "notes.account_id"));
    if (silencedFor !== null) query = query.where(unsilencedFor(silencedFor.onlooker));

    return await readPage(query, "id", page);
};

/**
 * The statuses by local users that quote `noteId`, only those by `accountIds` if given. Boosts
 * aren't quotes.
 */
export const localQuotesOf = async (
    ctx: Context,
    noteId: string,
    accountIds?: readonly string[],
): Promise<NoteRow[]> => {
    if (accountIds?.length === 0) return [];

    let query = ctx.db.selectFrom("notes").selectAll()
        .where("quote_id", "=", noteId)
        .where("instance_id", "is", null)
        .where("reblog_of_id", "is", null);
    if (accountIds !== undefined) query = query.where("account_id", "in", accountIds);

    return await query.orderBy("id").execute();
};
