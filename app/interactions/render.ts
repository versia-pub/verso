/**
 * Reactions as the client API renders them, in glitch-soc's format.
 * @see https://github.com/glitch-soc/mastodon/pull/2462
 * @module
 */
import type { StatusReaction } from "@versia/client-api";
import type { ShownEmoji } from "../emojis/emoji_queries.ts";
import { emojiPicture } from "../emojis/render.ts";
import type { Context } from "../kernel/context.ts";
import type { ReactionGroup, ReactionWithEmoji } from "./reaction_render_queries.ts";

/** What names a reaction's emoji. */
type Named = Pick<ReactionGroup, "text" | "shortcode" | "domain">;

/**
 * What the reactions with one emoji are called: the Unicode emoji, or the custom emoji's shortcode,
 * with its instance's domain if it is a remote instance's, like `blob@b.example`.
 */
export const reactionName = (group: Named): string => group.text ?? shortcodeOf(group);

/** A custom emoji's shortcode, as it is named among a status's custom emojis. */
const shortcodeOf = (group: Named) =>
    group.domain === null ? `${group.shortcode}` : `${group.shortcode}@${group.domain}`;

/** The URLs of a custom emoji's picture, or `undefined` for a Unicode emoji or one not ready. */
const pictureOf = (ctx: Context, reaction: Omit<ReactionWithEmoji, "id">) =>
    reaction.media_type === null
        ? undefined
        : emojiPicture(ctx, { ...reaction, media_type: reaction.media_type });

/**
 * A reaction's emoji, named like Pleroma's emoji reaction notifications name it: the Unicode emoji,
 * or the custom emoji's shortcode in colons. It has the picture's URL if the picture is ready.
 */
export const renderReactionEmoji = (
    ctx: Context,
    reaction: ReactionWithEmoji,
): { emoji: string; emoji_url: string | null } => ({
    emoji: reaction.text ?? `:${shortcodeOf(reaction)}:`,
    emoji_url: pictureOf(ctx, reaction)?.url ?? null,
});

/**
 * The reactions to a status with one emoji. For a signed-in viewer, it says whether they made one.
 * It has the custom emoji's picture URLs if the picture is ready.
 */
export const renderReaction = (
    ctx: Context,
    group: ReactionGroup,
    viewer: boolean,
): StatusReaction => {
    const picture = pictureOf(ctx, group);

    return {
        name: reactionName(group),
        count: group.count,
        remote: group.domain !== null,
        ...(viewer ? { me: group.me } : {}),
        ...(picture ? { url: picture.url, static_url: picture.still } : {}),
    };
};

/** Reactions to a status, by emoji, each rendered by {@link renderReaction}. */
export const renderReactions = (
    ctx: Context,
    groups: readonly ReactionGroup[],
    viewer: boolean,
): StatusReaction[] => groups.map((group) => renderReaction(ctx, group, viewer));

/** The custom emojis a status has reactions with, to display among its custom emojis. */
export const reactionEmojis = (groups: readonly ReactionGroup[]): ShownEmoji[] =>
    groups.flatMap((group) =>
        group.shortcode === null || group.media_type === null ? [] : [{
            shortcode: shortcodeOf(group),
            category: group.category,
            instance_id: group.instance_id,
            url: group.url,
            media_type: group.media_type,
            sha256: group.sha256,
            preview_sha256: group.preview_sha256,
            processed_at: group.processed_at,
        }]
    );
