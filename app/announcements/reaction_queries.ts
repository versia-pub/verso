/**
 * Users' reactions to announcements. Its queries read the `emojis` and `media` tables directly
 * rather than going through their modules, so that each takes one query.
 * @module
 */
import { sql } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";

/** What a reaction is made with: a Unicode emoji, or a custom one, but not both. */
export type AnnouncementEmoji =
    | { readonly text: string; readonly emoji_id: null }
    | { readonly text: null; readonly emoji_id: string };

/**
 * The reactions to an announcement with one emoji, and the custom emoji's picture, if it is one.
 */
export type ReactionGroup = {
    readonly announcement_id: string;
    readonly text: string | null;
    readonly emoji_id: string | null;
    readonly shortcode: string | null;
    readonly url: string | null;
    readonly media_type: string | null;
    readonly sha256: string | null;
    readonly preview_sha256: string | null;
    readonly processed_at: Date | null;
    readonly count: number;
    /** Whether the viewer is among them. */
    readonly me: boolean;
};

/** Reacts to an announcement for `accountId` with `emoji`. Returns whether they hadn't. */
export const insertReaction = async (
    ctx: Context,
    accountId: string,
    announcementId: string,
    emoji: AnnouncementEmoji,
): Promise<boolean> =>
    await ctx.db.insertInto("announcement_reactions")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            announcement_id: announcementId,
            text: emoji.text,
            emoji_id: emoji.emoji_id,
            created_at: ctx.clock.now(),
        })
        // Either index of one reaction with each emoji.
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst() !== undefined;

/** Undoes `accountId`'s reaction to an announcement with `emoji`. Returns whether they had. */
export const deleteReaction = async (
    ctx: Context,
    accountId: string,
    announcementId: string,
    emoji: AnnouncementEmoji,
): Promise<boolean> => {
    const query = ctx.db.deleteFrom("announcement_reactions")
        .where("account_id", "=", accountId)
        .where("announcement_id", "=", announcementId);

    return await (emoji.text === null
        ? query.where("emoji_id", "=", emoji.emoji_id)
        : query.where("text", "=", emoji.text))
        .returning("id")
        .executeTakeFirst() !== undefined;
};

/** How many emojis reactions to an announcement were made with, and whether `emoji` is one. */
export const emojisReactedWith = async (
    ctx: Context,
    announcementId: string,
    emoji: AnnouncementEmoji,
): Promise<{ readonly count: number; readonly includes: boolean }> => {
    const rows = await ctx.db.selectFrom("announcement_reactions")
        .select(["text", "emoji_id"])
        .where("announcement_id", "=", announcementId)
        .groupBy(["text", "emoji_id"])
        .execute();

    return {
        count: rows.length,
        includes: rows.some((row) => row.text === emoji.text && row.emoji_id === emoji.emoji_id),
    };
};

/**
 * The reactions to each of `announcementIds`, by announcement, and by emoji in the order they were
 * first used, with whether `viewerId` made each, if there is a viewer. With `emoji`, only those
 * with it.
 */
export const reactionsOf = async (
    ctx: Context,
    announcementIds: readonly string[],
    viewerId: string | null,
    emoji?: AnnouncementEmoji,
): Promise<Map<string, ReactionGroup[]>> => {
    if (announcementIds.length === 0) return new Map();

    let query = ctx.db.selectFrom("announcement_reactions")
        .leftJoin("emojis", "emojis.id", "announcement_reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .select((eb) => [
            "announcement_reactions.announcement_id",
            "announcement_reactions.text",
            "announcement_reactions.emoji_id",
            "emojis.shortcode",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
            countAll(eb),
            eb.fn.min("announcement_reactions.id").as("first_id"),
            eb.fn.max(
                sql<number>`case when ${
                    eb.ref("announcement_reactions.account_id")
                } = ${viewerId} then 1 else 0 end`,
            ).as("me"),
        ])
        .where("announcement_reactions.announcement_id", "in", announcementIds);
    if (emoji !== undefined) {
        query = emoji.text === null
            ? query.where("announcement_reactions.emoji_id", "=", emoji.emoji_id)
            : query.where("announcement_reactions.text", "=", emoji.text);
    }

    const rows = await query
        .groupBy([
            "announcement_reactions.announcement_id",
            "announcement_reactions.text",
            "announcement_reactions.emoji_id",
            "emojis.shortcode",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
        ])
        .orderBy("first_id")
        .execute();

    const groups = new Map<string, ReactionGroup[]>();
    for (const { first_id: _, ...row } of rows) {
        const group = { ...row, count: readCount(row), me: Number(row.me) === 1 };
        groups.set(row.announcement_id, [...groups.get(row.announcement_id) ?? [], group]);
    }

    return groups;
};
