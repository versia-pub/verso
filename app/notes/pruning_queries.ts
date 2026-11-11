import { type SelectQueryBuilder, sql } from "kysely";
import { uncountStatusesFor } from "../accounts/count_queries.ts";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteIdQuery } from "./removal_queries.ts";

/** Where a pass over old remote statuses has got to: the last one it looked at. */
export type PruneCursor = { readonly createdAt: Date; readonly id: string };

/**
 * Up to `limit` remote statuses and boosts created before `before`, after `after`, oldest first.
 * Exported for the tests of its query plan.
 */
export const oldRemoteNotesQuery = (
    ctx: Context,
    before: Date,
    after: PruneCursor | undefined,
    limit: number,
): SelectQueryBuilder<Database, "notes", { id: string; created_at: Date }> => {
    let query = ctx.db.selectFrom("notes").select(["id", "created_at"])
        .where("instance_id", "is not", null)
        .where("created_at", "<", before);
    if (after) {
        query = query.where((eb) =>
            eb(eb.refTuple("created_at", "id"), ">", eb.tuple(after.createdAt, after.id))
        );
    }

    return query.orderBy("created_at").orderBy("id").limit(limit);
};

/**
 * Which of the remote statuses `ids`, at least one, nothing here needs, so they can be pruned. One
 * is kept if it has replies, is pinned, mentions a local user, was liked, bookmarked, reacted to or
 * voted on by one, was boosted or quoted by one, replies to, boosts or quotes a local status, or
 * was boosted since `before`. Unless `keepFollowed` is false, so is one that home timelines show:
 * by an account a local user follows, boosted or quoted by one, or with a hashtag one follows.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/lib/mastodon/cli/statuses.rb
 */
export const prunableNoteIds = async (
    ctx: Context,
    ids: readonly string[],
    before: Date,
    keepFollowed: boolean,
): Promise<string[]> =>
    (await prunableNotesQuery(ctx, ids, before, keepFollowed).execute()).map((row) => row.id);

/** The query {@link prunableNoteIds} runs. Exported for the tests of its query plan. */
export const prunableNotesQuery = (
    ctx: Context,
    ids: readonly string[],
    before: Date,
    keepFollowed: boolean,
): SelectQueryBuilder<Database, "notes", { id: string }> => {
    // What local users follow, or nothing if `keepFollowed` is false.
    const following = sql<boolean>`${sql.lit(keepFollowed ? 1 : 0)} = 1`;
    const followed = ctx.db.selectFrom("follows")
        .innerJoin("accounts", "accounts.id", "follows.follower_id")
        .select("follows.followee_id")
        .where("follows.accepted", "=", true)
        .where("accounts.instance_id", "is", null)
        .where(following);
    const followedTags = ctx.db.selectFrom("tag_follows").select("tag_follows.tag")
        .where(following);
    return ctx.db.selectFrom("notes").select("notes.id")
        .where("notes.id", "in", ids)
        .where((eb) => {
            const localReaction = (table: "likes" | "reactions") =>
                eb.exists(
                    eb.selectFrom(table).select(`${table}.note_id`)
                        .whereRef(`${table}.note_id`, "=", "notes.id")
                        .where(`${table}.instance_id`, "is", null),
                );
            const localNote = (
                column: "notes.in_reply_to_id" | "notes.reblog_of_id" | "notes.quote_id",
            ) => eb.exists(
                eb.selectFrom("notes as other").select("other.id")
                    .whereRef("other.id", "=", column)
                    .where("other.instance_id", "is", null),
            );

            return eb.not(eb.or([
                eb("notes.account_id", "in", followed),
                eb.exists(
                    eb.selectFrom("note_tags").select("note_tags.note_id")
                        .whereRef("note_tags.note_id", "=", "notes.id")
                        .where("note_tags.name", "in", followedTags),
                ),
                eb.exists(
                    eb.selectFrom("notes as reply").select("reply.id")
                        .whereRef("reply.in_reply_to_id", "=", "notes.id"),
                ),
                eb.exists(
                    eb.selectFrom("notes as share").select("share.id")
                        .whereRef("share.reblog_of_id", "=", "notes.id")
                        .where((eb) =>
                            eb.or([
                                eb("share.instance_id", "is", null),
                                eb("share.account_id", "in", followed),
                                eb("share.created_at", ">=", before),
                            ])
                        ),
                ),
                eb.exists(
                    eb.selectFrom("notes as quote").select("quote.id")
                        .whereRef("quote.quote_id", "=", "notes.id")
                        .where((eb) =>
                            eb.or([
                                eb("quote.instance_id", "is", null),
                                eb("quote.account_id", "in", followed),
                            ])
                        ),
                ),
                localNote("notes.in_reply_to_id"),
                localNote("notes.reblog_of_id"),
                localNote("notes.quote_id"),
                eb.exists(
                    eb.selectFrom("note_pins").select("note_pins.note_id")
                        .whereRef("note_pins.note_id", "=", "notes.id"),
                ),
                eb.exists(
                    eb.selectFrom("bookmarks").select("bookmarks.note_id")
                        .whereRef("bookmarks.note_id", "=", "notes.id"),
                ),
                eb.exists(
                    eb.selectFrom("note_mentions")
                        .innerJoin("accounts", "accounts.id", "note_mentions.account_id")
                        .select("note_mentions.note_id")
                        .whereRef("note_mentions.note_id", "=", "notes.id")
                        .where("accounts.instance_id", "is", null),
                ),
                localReaction("likes"),
                localReaction("reactions"),
                eb.exists(
                    eb.selectFrom("polls")
                        .innerJoin("poll_votes", "poll_votes.poll_id", "polls.id")
                        .innerJoin("accounts", "accounts.id", "poll_votes.account_id")
                        .select("polls.id")
                        .whereRef("polls.note_id", "=", "notes.id")
                        .where("accounts.instance_id", "is", null),
                ),
            ]));
        });
};

/**
 * Decrements the status counts of the authors of `notes`, which are about to be pruned, and of the
 * boosts of them, which are deleted with them. A direct status isn't counted, so isn't uncounted.
 */
export const uncountPrunedAuthors = (ctx: Context, notes: NoteIdQuery): Promise<void> =>
    uncountStatusesFor(
        ctx,
        ctx.db.selectFrom("notes").select("notes.account_id")
            .where("notes.visibility", "!=", "direct")
            .where((eb) =>
                eb.or([eb("notes.id", "in", notes), eb("notes.reblog_of_id", "in", notes)])
            ),
    );
