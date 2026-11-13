/**
 * Renders custom emojis as the client API's entities.
 * @module
 */
import type { CustomEmoji, VersiaEmoji } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { fileUrl } from "../media/render.ts";
import type { EmojiPicture, LocalEmoji, ShownEmoji } from "./emoji_queries.ts";

/**
 * The URLs of an emoji's picture and of a still version of it. Once the picture is processed or
 * cached, they're the file Verso stores and its still preview. Otherwise a remote emoji's picture
 * is used for both, since it has no still version. The result is `undefined` for a local emoji
 * until it is processed, or if processing failed, and the emoji isn't shown then.
 */
export const emojiPicture = (
    ctx: Context,
    picture: EmojiPicture,
): { url: string; still: string } | undefined => {
    if (picture.processed_at !== null && picture.sha256 !== null) {
        const url = fileUrl(ctx, picture.sha256);

        return {
            url,
            still: picture.preview_sha256 === null ? url : fileUrl(ctx, picture.preview_sha256),
        };
    }
    if (picture.url !== null) return { url: picture.url, still: picture.url };

    return undefined;
};

/**
 * Custom emojis as the client API has them, without those whose pictures aren't ready. Only the
 * local instance's emojis are for the picker; remote instances' emojis are only for display.
 */
export const renderEmojis = (ctx: Context, emojis: readonly ShownEmoji[]): CustomEmoji[] =>
    emojis.flatMap((emoji) => {
        const picture = emojiPicture(ctx, emoji);
        if (picture === undefined) return [];

        return [{
            shortcode: emoji.shortcode,
            url: picture.url,
            static_url: picture.still,
            visible_in_picker: emoji.instance_id === null,
            category: emoji.category,
        }];
    });

/**
 * One of the local instance's emojis, rendered for Versia's emoji endpoints, with its picture's
 * URLs `null` until it is processed.
 */
export const renderVersiaEmoji = (ctx: Context, emoji: LocalEmoji): VersiaEmoji => {
    const picture = emojiPicture(ctx, emoji);

    return {
        id: emoji.id,
        shortcode: emoji.shortcode,
        url: picture?.url ?? null,
        static_url: picture?.still ?? null,
        visible_in_picker: true,
        category: emoji.category,
        global: emoji.account_id === null,
        description: emoji.description,
    };
};
