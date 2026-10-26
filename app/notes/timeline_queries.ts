import { hasAttachments } from "../media/attachment_queries.ts";
import type { ExpressionBuilder } from "kysely";
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
 * A page of `viewerId`'s home timeline, newest first: all their own statuses and boosts, the
 * statuses of `followed` that they may see, and the boosts of `sharing`, the accounts of `followed`
 * whose boosts they see. Of those statuses, a direct one must mention them, and a reply must be to
 * them or to someone they follow, with its author among them, as on Mastodon. Nothing from the
 * accounts they block or mute, `hidden`, is included, nor anyone's boosts of their statuses. Each
 * of the three sets is read on its own, so each can use the index that suits it, however many
 * accounts they follow. No status is in two of them, as no one follows themselves.
 */
export const homePage = async (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    hidden: Excluded,
    page: PageBounds,
): Promise<NoteRow[]> => {
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

    const pages = [];
    for (const query of [own, shares, others]) pages.push(await readPage(query, "notes.id", page));

    return mergePages(pages, page);
};

/**
 * Where the statuses on a public timeline come from: anywhere, the local instance, or remote
 * instances.
 */
export type Origin = "all" | "local" | "remote";

/**
 * A page of the public timeline, newest first: public statuses from `origin`, without replies
 * (except replies to their own authors) or boosts, as on Mastodon, and with `onlyMedia`, only those
 * with media attached. If there is a viewer, the statuses of the accounts they block or mute,
 * `hidden`, are omitted.
 */
export const publicPage = async (
    ctx: Context,
    origin: Origin,
    hidden: Excluded | null,
    page: PageBounds,
    onlyMedia = false,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("notes").selectAll()
        .where("visibility", "=", "public")
        .where("reblog_of_id", "is", null)
        .where((eb) =>
            eb.or([
                eb("in_reply_to_account_id", "is", null),
                eb("in_reply_to_account_id", "=", eb.ref("account_id")),
            ])
        );

    if (hidden !== null) query = query.where(without(hidden));
    if (origin === "local") query = query.where("instance_id", "is", null);
    if (origin === "remote") query = query.where("instance_id", "is not", null);
    if (onlyMedia) query = query.where(hasAttachments);

    return await readPage(query, "notes.id", page);
};
