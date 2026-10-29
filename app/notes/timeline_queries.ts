import { hasAttachments } from "../media/attachment_queries.ts";
import type { ExpressionBuilder, ExpressionWrapper, SelectQueryBuilder, SqlBool } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, isExcluded, notExcluded } from "../graph/blocks.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";

/** Excludes the statuses and boosts of the accounts `hidden`, and any boosts of their statuses. */
const without = (hidden: Excluded) => (eb: ExpressionBuilder<Database, "notes">) =>
    eb.and([
        notExcluded(hidden, "notes.account_id")(eb),
        eb.or([
            eb("notes.reblog_of_id", "is", null),
            eb.not(eb.exists(
                eb.selectFrom("notes as shared").select("shared.id")
                    .whereRef("shared.id", "=", "notes.reblog_of_id")
                    .where(isExcluded(hidden, "shared.account_id")),
            )),
        ]),
    ]);

/**
 * Given pages with the same bounds, whose rows are all distinct, returns the page of all their rows
 * combined, as `readPage` would read it.
 */
const mergePages = (pages: readonly NoteRow[][], page: PageBounds) => {
    const newestFirst = pages.flat().toSorted((a, b) => b.id.localeCompare(a.id));

    // Just after `min_id` are its oldest rows.
    return page.min_id === undefined
        ? newestFirst.slice(0, page.limit)
        : newestFirst.slice(-page.limit);
};

/**
 * The statuses on `viewerId`'s home timeline: all their own statuses and boosts, the statuses of
 * `followed` that they may see, and the boosts of `sharing`, the accounts of `followed` whose
 * boosts they see. Of those statuses, a direct one must mention them, and a reply must be to them
 * or to someone they follow, with its author among them, as on Mastodon. Nothing from the accounts
 * they block or mute, `hidden`, is included, nor anyone's boosts of their statuses. They are three
 * queries, so each can use the index that suits it, however many accounts they follow. No status
 * is in two of them, as no one follows themselves.
 */
const homeQueries = (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    hidden: Excluded,
) => {
    const notes = ctx.db.selectFrom("notes").selectAll().where(without(hidden));

    const own = notes.where("account_id", "=", viewerId);
    // Boosts are never direct, so any of them is visible to the booster's followers.
    const shares = notes.where("reblog_of_id", "is not", null).where("account_id", "in", sharing);
    const others = notes
        .where("reblog_of_id", "is", null)
        .where("account_id", "in", followed)
        .where((eb) =>
            eb.and([
                eb.or([
                    eb("visibility", "!=", "direct"),
                    eb.exists(
                        eb.selectFrom("note_mentions").select("note_mentions.note_id")
                            .whereRef("note_mentions.note_id", "=", "notes.id")
                            .where("note_mentions.account_id", "=", viewerId),
                    ),
                ]),
                // Not a reply, or a reply to them or to someone they follow.
                eb.or([
                    eb("in_reply_to_account_id", "is", null),
                    eb("in_reply_to_account_id", "=", viewerId),
                    eb("in_reply_to_account_id", "in", followed),
                ]),
            ])
        );

    return [own, shares, others];
};

/**
 * A page of `viewerId`'s home timeline, newest first, of the statuses {@link homeQueries} finds.
 */
export const homePage = async (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    hidden: Excluded,
    page: PageBounds,
): Promise<NoteRow[]> => {
    const pages = [];
    for (const query of homeQueries(ctx, viewerId, followed, sharing, hidden)) {
        pages.push(await readPage(query, "notes.id", page));
    }

    return mergePages(pages, page);
};

/** The status `noteId`, if it is on `viewerId`'s home timeline, as {@link homeQueries} finds. */
export const findHomeNote = async (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    hidden: Excluded,
    noteId: string,
): Promise<NoteRow | undefined> => {
    for (const query of homeQueries(ctx, viewerId, followed, sharing, hidden)) {
        const note = await query.where("notes.id", "=", noteId).executeTakeFirst();
        if (note) return note;
    }
};

/**
 * Where the statuses on a public timeline come from: anywhere, the local instance, or remote
 * instances.
 */
export type Origin = "all" | "local" | "remote";

/**
 * The statuses on the public timeline: public statuses, without replies (except replies to their
 * own authors) or boosts, as on Mastodon. If there is a viewer, the statuses of the accounts they
 * block or mute, `hidden`, are omitted.
 */
const publicQuery = (ctx: Context, hidden: Excluded | null) => {
    const query = ctx.db.selectFrom("notes").selectAll()
        .where("visibility", "=", "public")
        .where("reblog_of_id", "is", null)
        .where((eb) =>
            eb.or([
                eb("in_reply_to_account_id", "is", null),
                eb("in_reply_to_account_id", "=", eb.ref("account_id")),
            ])
        );

    return hidden === null ? query : query.where(without(hidden));
};

/** `query`'s statuses from `origin`, and with `onlyMedia`, only those with media attached. */
const fromOrigin = (
    query: SelectQueryBuilder<Database, "notes", NoteRow>,
    origin: Origin,
    onlyMedia: boolean,
) => {
    let from = query;
    if (origin === "local") from = from.where("instance_id", "is", null);
    if (origin === "remote") from = from.where("instance_id", "is not", null);
    if (onlyMedia) from = from.where(hasAttachments);

    return from;
};

/**
 * A page of the public timeline, newest first, of the statuses {@link publicQuery} finds from
 * `origin`, and with `onlyMedia`, only those with media attached.
 */
export const publicPage = async (
    ctx: Context,
    origin: Origin,
    hidden: Excluded | null,
    page: PageBounds,
    onlyMedia = false,
): Promise<NoteRow[]> => {
    return await readPage(
        fromOrigin(publicQuery(ctx, hidden), origin, onlyMedia),
        "notes.id",
        page,
    );
};

/** The status `noteId`, if it is on the public timeline, as {@link publicQuery} finds. */
export const findPublicNote = async (ctx: Context, noteId: string): Promise<NoteRow | undefined> =>
    await publicQuery(ctx, null).where("notes.id", "=", noteId).executeTakeFirst();

/**
 * The hashtags the statuses on a hashtag's timeline use: at least one of `any`, which must have
 * some, every one of `all`, and none of `none`.
 */
export type HashtagFilter = {
    readonly any: readonly string[];
    readonly all: readonly string[];
    readonly none: readonly string[];
};

/** A condition on statuses, for a query's `where`. */
export type NoteCondition = (
    eb: ExpressionBuilder<Database, "notes">,
) => ExpressionWrapper<Database, "notes", SqlBool>;

/** Whether a status uses any of `names`. */
export const usesAny = (names: readonly string[]): NoteCondition => (eb) =>
    eb.exists(
        eb.selectFrom("note_tags").select("note_tags.note_id")
            .whereRef("note_tags.note_id", "=", "notes.id")
            .where("note_tags.name", "in", names),
    );

/**
 * The statuses that could be on a hashtag's timeline: public ones, replies too, as on Mastodon.
 * Boosts use no hashtags, so are on none, and leaving them out lets the public timelines' index
 * find the rest. If there is a viewer, the statuses of the accounts they block or mute, `hidden`,
 * are omitted.
 */
const hashtagQuery = (ctx: Context, hidden: Excluded | null) => {
    const query = ctx.db.selectFrom("notes").selectAll()
        .where("visibility", "=", "public")
        .where("reblog_of_id", "is", null);
    return hidden === null ? query : query.where(without(hidden));
};

/**
 * A page of a hashtag's timeline, newest first, as Mastodon assembles it: the statuses
 * {@link hashtagQuery} finds that use the hashtags `tags` asks for, from `origin`, and with
 * `onlyMedia`, only those with media attached.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/tag_feed.rb
 */
export const hashtagPage = async (
    ctx: Context,
    tags: HashtagFilter,
    origin: Origin,
    hidden: Excluded | null,
    page: PageBounds,
    onlyMedia: boolean,
): Promise<NoteRow[]> => {
    let query = hashtagQuery(ctx, hidden).where(usesAny(tags.any));
    for (const name of tags.all) query = query.where(usesAny([name]));
    if (tags.none.length > 0) query = query.where((eb) => eb.not(usesAny(tags.none)(eb)));

    return await readPage(fromOrigin(query, origin, onlyMedia), "notes.id", page);
};

/** The status `noteId`, if it could be on a hashtag's timeline, as {@link hashtagQuery} finds. */
export const findHashtagNote = async (ctx: Context, noteId: string): Promise<NoteRow | undefined> =>
    await hashtagQuery(ctx, null).where("notes.id", "=", noteId).executeTakeFirst();
