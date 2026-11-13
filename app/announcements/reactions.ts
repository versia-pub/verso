/**
 * Reactions to announcements, each with an emoji: a Unicode one, or a custom one from the local
 * instance's emojis, named by its shortcode without colons. A user reacts to an announcement with
 * each emoji once, and with as many emojis as they like, but an announcement's reactions are made
 * with only a few different emojis in all. They aren't federated.
 * @see https://docs.joinmastodon.org/methods/announcements/#put-reactions
 * @module
 */
import { z } from "zod";
import { usableEmojiIds } from "../emojis/emoji_queries.ts";
import { isUnicodeEmoji } from "../interactions/reactions.ts";
import type { Context } from "../kernel/context.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import { findPublishedAnnouncement } from "./announcement_queries.ts";
import {
    type AnnouncementEmoji,
    deleteReaction,
    emojisReactedWith,
    insertReaction,
} from "./reaction_queries.ts";

/**
 * Which announcement's reactions with an emoji changed: the emoji's name, and its id if it is a
 * custom one.
 */
export type AnnouncementReactedMessage = {
    readonly announcementId: string;
    readonly name: string;
    readonly emojiId: string | null;
};

/** Says an announcement's reactions with an emoji changed, so every process can stream it. */
export const announcementReacted: Channel<AnnouncementReactedMessage> = {
    name: "announcements.reacted",
    schema: z.object({
        announcementId: z.string(),
        name: z.string(),
        emojiId: z.string().nullable(),
    }),
};

/** Mastodon's limit on how many different emojis an announcement's reactions are made with. */
export const reactionLimit = 8;

/**
 * The emoji a user names to react with: a Unicode emoji, or one of the local instance's global
 * custom emojis by its shortcode, like `blobcat`, or `undefined` if it is neither.
 */
export const announcementEmoji = async (
    ctx: Context,
    name: string,
): Promise<AnnouncementEmoji | undefined> => {
    if (isUnicodeEmoji(name)) return { text: name, emoji_id: null };

    // Only global ones, so that each reaction's name is one emoji.
    const [id] = await usableEmojiIds(ctx, null, [name]);
    return id === undefined ? undefined : { text: null, emoji_id: id };
};

/** The result of reacting to an announcement. */
export type ReactResult =
    | "reacted"
    /** There is no such announcement, or it isn't published. */
    | "missing"
    /** The emoji is neither Unicode nor the local instance's. */
    | "unknown emoji"
    /** The announcement has reactions with the most emojis already, and this is a new one. */
    | "limit reached"
    /** They reacted with it already. */
    | "duplicate";

/**
 * Reacts to the published announcement `id` for `accountId`, a local user, with the emoji `name`.
 */
export const reactToAnnouncement = (
    ctx: Context,
    accountId: string,
    id: string,
    name: string,
): Promise<ReactResult> =>
    ctx.transaction(async (tx) => {
        if (await findPublishedAnnouncement(tx, id) === undefined) return "missing";

        const emoji = await announcementEmoji(tx, name);
        if (emoji === undefined) return "unknown emoji";

        const used = await emojisReactedWith(tx, id, emoji);
        if (!used.includes && used.count >= reactionLimit) return "limit reached";
        if (!await insertReaction(tx, accountId, id, emoji)) return "duplicate";

        await publish(tx, announcementReacted, {
            announcementId: id,
            name,
            emojiId: emoji.emoji_id,
        });
        return "reacted";
    });

/**
 * Undoes `accountId`'s reaction to the published announcement `id` with the emoji `name`. Returns
 * whether there was one.
 */
export const unreactToAnnouncement = (
    ctx: Context,
    accountId: string,
    id: string,
    name: string,
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (await findPublishedAnnouncement(tx, id) === undefined) return false;

        const emoji = await announcementEmoji(tx, name);
        if (emoji === undefined || !await deleteReaction(tx, accountId, id, emoji)) return false;

        await publish(tx, announcementReacted, {
            announcementId: id,
            name,
            emojiId: emoji.emoji_id,
        });
        return true;
    });
