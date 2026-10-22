/**
 * Reactions as the client API shows them, as Versia Server has them.
 * @module
 */
import type { StatusReaction } from "@versia/client-api";
import type { ShownEmoji } from "../emojis/emoji_queries.ts";
import type { ReactionGroup } from "./reaction_queries.ts";

/**
 * What the reactions with one emoji are called: the Unicode emoji, or the custom emoji's shortcode
 * in colons, with its instance's domain if it is another instance's, such as `:blob@b.example:`.
 */
export const reactionName = (group: ReactionGroup): string =>
    group.text ?? `:${shortcodeOf(group)}:`;

/** A custom emoji's shortcode, as it is named among a status's emojis. */
const shortcodeOf = (group: ReactionGroup) =>
    group.domain === null ? `${group.shortcode}` : `${group.shortcode}@${group.domain}`;

/** The reactions to a status with one emoji, with whether the viewer made one, for a viewer. */
export const renderReaction = (group: ReactionGroup, viewer: boolean): StatusReaction => ({
    name: reactionName(group),
    count: group.count,
    remote: group.domain !== null,
    ...(viewer ? { me: group.me } : {}),
});

/** Reactions to a status, by emoji, as {@link renderReaction} has them. */
export const renderReactions = (
    groups: readonly ReactionGroup[],
    viewer: boolean,
): StatusReaction[] => groups.map((group) => renderReaction(group, viewer));

/** The custom emojis a status is reacted to with, to show among its emojis. */
export const reactionEmojis = (groups: readonly ReactionGroup[]): ShownEmoji[] =>
    groups.flatMap((group) =>
        group.shortcode === null || group.media_type === null ? [] : [{
            shortcode: shortcodeOf(group),
            instance_id: group.instance_id,
            url: group.url,
            media_type: group.media_type,
        }]
    );
