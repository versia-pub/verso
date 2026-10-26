/**
 * Renders custom emojis as the client API's entities.
 * @module
 */
import type { CustomEmoji } from "@versia/client-api";
import type { ShownEmoji } from "./emoji_queries.ts";

/**
 * Custom emojis as the client API has them. Pictures are served from where they are, as Verso makes
 * no still versions of them, and those Verso stores itself are omitted until it can serve them.
 * Only the local instance's emojis are for the picker; remote instances' emojis are only for
 * display.
 */
export const renderEmojis = (emojis: readonly ShownEmoji[]): CustomEmoji[] =>
    emojis.flatMap((emoji) =>
        emoji.url === null ? [] : [{
            shortcode: emoji.shortcode,
            url: emoji.url,
            static_url: emoji.url,
            visible_in_picker: emoji.instance_id === null,
            category: null,
        }]
    );
