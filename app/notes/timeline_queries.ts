import type { ExpressionBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";

/** Leaves out the notes and shares of the accounts `hidden`, and any shares of their notes. */
const without = (hidden: AccountIdQuery) => (eb: ExpressionBuilder<Database, "notes">) =>
    eb.and([
        eb("notes.account_id", "not in", hidden),
        eb.or([
            eb("notes.reblog_of_id", "is", null),
            eb(
                "notes.reblog_of_id",
                "not in",
                eb.selectFrom("notes as shared").select("shared.id")
                    .where("shared.account_id", "in", hidden),
            ),
        ]),
    ]);

/**
 * A page of `viewerId`'s home timeline, newest first: all their own notes and shares, those notes
 * of `followed` that they may see, and the shares of `sharing`, the accounts of `followed` whose
 * shares they see. Of those notes, a direct one must mention them, and a reply must be to them or
 * to someone they follow, its author among them, as on Mastodon. Nothing of the accounts they
 * block or mute, `hidden`, is in it, nor anyone's shares of their notes.
 */
export const homePage = async (
    ctx: Context,
    viewerId: string,
    followed: AccountIdQuery,
    sharing: AccountIdQuery,
    hidden: AccountIdQuery,
    page: PageBounds,
): Promise<NoteRow[]> => {
    const query = ctx.db.selectFrom("notes").selectAll()
        .where(without(hidden))
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
 * their own authors, or shares, as on Mastodon. The notes of the accounts the viewer blocks or
 * mutes, `hidden`, if there is a viewer, are left out.
 */
export const publicPage = async (
    ctx: Context,
    origin: Origin,
    hidden: AccountIdQuery | null,
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

    if (hidden !== null) query = query.where(without(hidden));
    if (origin === "local") query = query.where("instance_id", "is", null);
    if (origin === "remote") query = query.where("instance_id", "is not", null);

    return await readPage(query, "notes.id", page);
};
