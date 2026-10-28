/**
 * Custom emojis as Versia has them, in the `extensions` of the entities whose text uses them.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import { remotePicture } from "../media/versia.ts";
import type { EmojiPicture } from "./emoji_queries.ts";
import type { RemoteEmoji } from "./emojis.ts";
import { emojiPicture } from "./render.ts";

/**
 * How many emojis of one entity Verso stores. Each costs queries, so an entity can't make Verso do
 * unbounded work.
 */
const remoteEmojiLimit = 100;

/**
 * The emojis an entity's `extensions` say its text uses, without any whose picture clients can't
 * display, and with the first of any named twice. Versia lets names have other characters around
 * them, but Mastodon's clients only look for colons, so emojis named otherwise are omitted. An
 * extension that isn't as Versia defines it is treated as having none.
 */
export const remoteEmojisOf = (
    extensions: v0_6.Entity["extensions"],
): RemoteEmoji[] => {
    const parsed = v0_6.CustomEmojis.safeParse(extensions?.[v0_6.customEmojisKey]);
    if (!parsed.success) return [];

    const emojis = new Map<string, RemoteEmoji>();
    for (const emoji of parsed.data.emojis) {
        // At most as long as local ones.
        const shortcode = /^:([A-Za-z0-9_-]{1,100}):$/u.exec(emoji.name)?.[1];
        const picture = remotePicture(emoji.content);
        if (shortcode === undefined || picture === null || emojis.has(shortcode)) continue;

        emojis.set(shortcode, { shortcode, picture });
        if (emojis.size === remoteEmojiLimit) break;
    }

    return [...emojis.values()];
};

/**
 * The `extensions` of an entity whose text uses `emojis`, or `undefined` if it uses none. Emojis
 * whose pictures aren't ready are omitted.
 */
export const emojiExtensions = (
    ctx: Context,
    emojis: readonly (EmojiPicture & { readonly shortcode: string })[],
): v0_6.Entity["extensions"] => {
    const shown = emojis.flatMap((emoji): v0_6.CustomEmoji[] => {
        const picture = emojiPicture(ctx, emoji);
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
