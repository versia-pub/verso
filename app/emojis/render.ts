/**
 * Renders custom emojis as the client API's entities.
 * @module
 */
import type { CustomEmoji } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { fileUrl } from "../media/render.ts";
import type { EmojiPicture, ShownEmoji } from "./emoji_queries.ts";

/**
 * The URLs of an emoji's picture and of a still version of it: a remote emoji's own at its URL,
 * which has no still version, or one Verso stores, with its still preview, once processed. Until
 * then, or if processing failed, it is `undefined`, and the emoji isn't shown.
 */
export const emojiPicture = (
    ctx: Context,
    picture: EmojiPicture,
): { url: string; still: string } | undefined => {
    if (picture.url !== null) return { url: picture.url, still: picture.url };
    if (picture.processed_at === null || picture.sha256 === null) return undefined;

    const url = fileUrl(ctx, picture.sha256);
    return {
        url,
        still: picture.preview_sha256 === null ? url : fileUrl(ctx, picture.preview_sha256),
    };
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
