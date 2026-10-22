/**
 * Turns custom emojis into the client API's entities.
 * @module
 */
import type { CustomEmoji } from "@versia/client-api";
import type { ShownEmoji } from "./emoji_queries.ts";

/**
 * Emojis as the client API has them. Pictures are shown where they are, as Verso makes no still
 * versions of them, and those Verso keeps itself are left out until it can serve them. Only this
 * instance's emojis are for the picker; other instances' ones are only for showing.
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
