import { type PageBounds, readPage } from "../db/paging.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";

/**
 * A page of `viewerId`'s home timeline, newest first: all their own notes and shares, those notes
 * of `followed` that they may see, and the shares of `sharing`, the accounts of `followed` whose
 * shares they see. Of those notes, a direct one must mention them, and a reply must be to them or
 * to someone they follow, its author among them, as on Mastodon.
 */
export const homePage = async (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    page: PageBounds,
): Promise<NoteRow[]> => {
    const query = ctx.db.selectFrom("notes").selectAll()
        .where((eb) =>
            eb.or([
                eb("account_id", "=", viewerId),
                // Shares are never direct, so any of them is for their followers.
                eb.and([eb("reblog_of_id", "is not", null), eb("account_id", "in", sharing)]),
                eb.and([
                    eb("reblog_of_id", "is", null),
                    eb("account_id", "in", followed),
                    eb.or([
                        eb("visibility", "!=", "direct"),
                        eb.exists(
                            eb.selectFrom("note_mentions").select("note_mentions.note_id")
                                .whereRef("note_mentions.note_id", "=", "notes.id")
                                .where("note_mentions.account_id", "=", viewerId),
                        ),
                    ]),
                    // Not a reply, or one to them or to someone they follow too.
                    eb.or([
                        eb("in_reply_to_account_id", "is", null),
                        eb("in_reply_to_account_id", "=", viewerId),
                        eb("in_reply_to_account_id", "in", followed),
                    ]),
                ]),
            ])
        );

    return await readPage(query, "notes.id", page);
};

/** Where the notes on a public timeline are from: anywhere, this instance, or other instances. */
export type Origin = "all" | "local" | "remote";

/**
 * A page of the public timeline, newest first: public notes from `origin`, without replies but to
 * their own authors, or shares, as on Mastodon.
 */
export const publicPage = async (
    ctx: Context,
    origin: Origin,
    page: PageBounds,
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

    if (origin === "local") query = query.where("instance_id", "is", null);
    if (origin === "remote") query = query.where("instance_id", "is not", null);

    return await readPage(query, "notes.id", page);
};
