/**
 * Turns custom emojis into the client API's entities.
 * @module
 */
import type { CustomEmoji } from "@versia/client-api";
import type { UsedEmoji } from "./emoji_queries.ts";

/**
 * Emojis something uses, as the client API has them. Other instances' pictures are shown where
 * they are, as Verso makes no still versions of them, and they are only for showing, not for the
 * picker.
 */
export const renderEmojis = (emojis: readonly UsedEmoji[]): CustomEmoji[] =>
    emojis.flatMap((emoji) =>
        emoji.url === null ? [] : [{
            shortcode: emoji.shortcode,
            url: emoji.url,
            static_url: emoji.url,
            visible_in_picker: false,
            category: null,
        }]
    );
