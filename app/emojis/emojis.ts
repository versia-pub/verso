/**
 * Custom emojis, which text displays where it has their names, such as `:blobcat:`. Remote
 * instances' emojis are stored as they name them, one per name per instance, as on Mastodon: a
 * newer picture for a name replaces the older one wherever it is used.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { type RemoteMedia, saveRemoteMedia } from "../media/media_queries.ts";
import { findRemoteEmoji, insertEmoji } from "./emoji_queries.ts";

/** A remote instance's custom emoji, as it names it. */
export type RemoteEmoji = {
    /** Without the colons around it. */
    readonly shortcode: string;
    readonly picture: RemoteMedia;
};

/**
 * Stores custom emojis of the instance `instanceId`, each replacing the one Verso has under its
 * name, if it has one. Returns their ids, in the order given.
 */
export const keepRemoteEmojis = async (
    ctx: Context,
    instanceId: string,
    emojis: readonly RemoteEmoji[],
): Promise<string[]> => {
    const ids = [];

    for (const emoji of emojis) {
        const existing = await findRemoteEmoji(ctx, instanceId, emoji.shortcode);
        if (existing) {
            await saveRemoteMedia(ctx, instanceId, existing.media_id, emoji.picture);
            ids.push(existing.id);
            continue;
        }

        const id = ctx.ids();
        await insertEmoji(ctx, {
            id,
            instance_id: instanceId,
            shortcode: emoji.shortcode,
            media_id: await saveRemoteMedia(ctx, instanceId, null, emoji.picture),
            created_at: ctx.clock.now(),
        });
        ids.push(id);
    }

    return ids;
};
