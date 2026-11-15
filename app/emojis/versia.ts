/**
 * Custom emojis as Versia has them, in the `extensions` of the entities whose text uses them.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import { v0_6, v0_7 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import type { RemoteMedia } from "../media/media_queries.ts";
import { remoteMediaV07, remotePicture } from "../media/versia.ts";
import { pictureTypes } from "../media/uploads.ts";
import type { EmojiPicture } from "./emoji_queries.ts";
import type { RemoteEmoji } from "./emojis.ts";
import { emojiPicture } from "./render.ts";

/**
 * How many emojis of one entity Verso stores. Each costs queries, so an entity can't make Verso do
 * unbounded work.
 */
const remoteEmojiLimit = 100;

/**
 * The emojis of `emojis` that Verso can use, whichever version of Versia they came in: only those
 * with a shortcode, and a picture that `picture` gives, and the first of any named twice. Pictures
 * are looked at only for emojis that get that far, so a long list costs little.
 */
const remoteEmojis = (
    emojis: readonly { readonly name: string; readonly picture: () => RemoteMedia | null }[],
): RemoteEmoji[] => {
    const kept = new Map<string, RemoteEmoji>();

    for (const emoji of emojis) {
        // At most as long as local ones.
        const shortcode = /^:([A-Za-z0-9_-]{1,100}):$/u.exec(emoji.name)?.[1];
        if (shortcode === undefined || kept.has(shortcode)) continue;

        const picture = emoji.picture();
        if (picture === null) continue;

        kept.set(shortcode, { shortcode, picture });
        if (kept.size === remoteEmojiLimit) break;
    }

    return [...kept.values()];
};

/**
 * The emojis an entity's `extensions` say its text uses, without any whose picture clients can't
 * display, and with the first of any named twice. Versia lets names have other characters around
 * them, but Mastodon's clients only look for colons, so emojis named otherwise are omitted. An
 * extension that doesn't match what Versia defines is treated as having no emojis.
 */
export const remoteEmojisOf = (
    extensions: v0_6.Entity["extensions"],
): RemoteEmoji[] => {
    const parsed = v0_6.CustomEmojis.safeParse(extensions?.[v0_6.customEmojisKey]);
    if (!parsed.success) return [];

    return remoteEmojis(
        parsed.data.emojis.map((emoji) => ({
            name: emoji.name,
            picture: () => remotePicture(emoji.content),
        })),
    );
};

/** The emojis of a v0.7 entity's `extensions`, as {@link remoteEmojisOf} reads them. */
export const remoteEmojisOfV07 = (extensions: v0_7.Entity["extensions"]): RemoteEmoji[] => {
    const parsed = v0_7.CustomEmojis.safeParse(extensions?.[v0_7.customEmojisKey]);
    if (!parsed.success) return [];

    return remoteEmojis(
        parsed.data.emojis.map((emoji) => ({
            name: emoji.name,
            picture: () => remoteMediaV07(emoji.content, (type) => pictureTypes.has(type)),
        })),
    );
};

/**
 * The `extensions` of an entity whose text uses `emojis`, or `undefined` if it uses none. Emojis
 * whose pictures aren't ready are omitted. A remote emoji is given at its instance's URL, with the
 * type its instance gave, rather than from Verso's cache.
 */
export const emojiExtensions = (
    ctx: Context,
    emojis: readonly (EmojiPicture & { readonly shortcode: string })[],
): v0_6.Entity["extensions"] => {
    const shown = emojis.flatMap((emoji): v0_6.CustomEmoji[] => {
        const picture = emoji.url === null ? emojiPicture(ctx, emoji) : { url: emoji.url };
        if (picture === undefined) return [];

        return [{
            name: `:${emoji.shortcode}:`,
            content: { [emoji.media_type]: { content: picture.url, remote: true } },
        }];
    });

    if (shown.length === 0) return undefined;

    const extension: v0_6.CustomEmojis = { emojis: shown };

    return { [v0_6.customEmojisKey]: extension };
};

/** The `extensions` of a v0.7 entity whose text uses `emojis`, as {@link emojiExtensions}. */
export const emojiExtensionsV07 = (
    ctx: Context,
    emojis: readonly (EmojiPicture & { readonly shortcode: string })[],
): v0_7.Entity["extensions"] => {
    const shown = emojis.flatMap((emoji): v0_7.CustomEmoji[] => {
        const picture = emoji.url === null ? emojiPicture(ctx, emoji) : { url: emoji.url };
        if (picture === undefined) return [];

        return [{
            name: `:${emoji.shortcode}:`,
            content: { url: picture.url, media_type: emoji.media_type },
        }];
    });

    if (shown.length === 0) return undefined;

    const extension: v0_7.CustomEmojis = { emojis: shown };

    return { [v0_7.customEmojisKey]: extension };
};
