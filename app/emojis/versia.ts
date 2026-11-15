/**
 * Custom emojis as Versia has them, in the `extensions` of the entities whose text uses them.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import { v0_7 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import { remoteMedia } from "../media/versia.ts";
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
 * The emojis an entity's `extensions` say its text uses: only those with a shortcode, and a picture
 * clients can display, and the first of any named twice. Versia lets names have other characters
 * around them, but Mastodon's clients only look for colons, so emojis named otherwise are omitted.
 * An extension that doesn't match what Versia defines is treated as having no emojis. Pictures are
 * looked at only for emojis that get that far, so a long list costs little.
 */
export const remoteEmojisOf = (extensions: v0_7.Entity["extensions"]): RemoteEmoji[] => {
    const parsed = v0_7.CustomEmojis.safeParse(extensions?.[v0_7.customEmojisKey]);
    if (!parsed.success) return [];

    const kept = new Map<string, RemoteEmoji>();

    for (const emoji of parsed.data.emojis) {
        // At most as long as local ones.
        const shortcode = /^:([A-Za-z0-9_-]{1,100}):$/u.exec(emoji.name)?.[1];
        if (shortcode === undefined || kept.has(shortcode)) continue;

        const picture = remoteMedia(emoji.content, (type) => pictureTypes.has(type));
        if (picture === null) continue;

        kept.set(shortcode, { shortcode, picture });
        if (kept.size === remoteEmojiLimit) break;
    }

    return [...kept.values()];
};

/**
 * The `extensions` of an entity whose text uses `emojis`, or `undefined` if it uses none. Emojis
 * whose pictures aren't ready are omitted. A remote emoji is given at its instance's URL, with the
 * type its instance gave, rather than from Verso's cache.
 */
export const emojiExtensions = (
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
