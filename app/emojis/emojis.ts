/**
 * Custom emojis, which text displays where it has their names, such as `:blobcat:`. Remote
 * instances' emojis are stored as they name them, one per name per instance, as on Mastodon: a
 * newer picture for a name replaces the older one wherever it is used.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import { Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import type { Fit } from "../kernel/images.ts";
import { type RemoteMedia, saveRemoteMedia } from "../media/media_queries.ts";
import { uploadPicture } from "../media/uploads.ts";
import { findRemoteEmoji, hasUsableEmoji, insertEmoji, insertLocalEmoji } from "./emoji_queries.ts";

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

/** A custom emoji a local user adds. */
export type NewEmoji = {
    /** Without the colons around it. */
    readonly shortcode: string;
    readonly picture: File;
    /** The picture's alt text. */
    readonly description?: string;
    /** The emoji picker's group for it. */
    readonly category?: string;
    /** Whether it is a global emoji, rather than the own emoji of the user who adds it. */
    readonly global: boolean;
};

/** The box emojis' pictures are scaled down to fit in, larger than any client displays them. */
const emojiFit: Fit = { width: 128, height: 128 };

/**
 * Adds a custom emoji from the local user `accountId`, and returns its id. Its picture is processed
 * by a job, and until then text doesn't use the emoji. A user can't add one named as one they may
 * already use, their own or a global one, though users may each have one of the same name, as
 * in Versia Server.
 */
export const addEmoji = async (
    ctx: Context,
    accountId: string,
    emoji: NewEmoji,
): Promise<string> => {
    const taken = `An emoji named ${emoji.shortcode} already exists, yours or global`;
    if (await hasUsableEmoji(ctx, accountId, emoji.shortcode)) throw new Unprocessable(taken);

    const picture = await uploadPicture(ctx, accountId, {
        file: emoji.picture,
        mediaType: emoji.picture.type,
        description: emoji.description || undefined,
    }, emojiFit);
    if (picture === undefined) throw new Unprocessable("The picture must be an image");

    // Someone may have added one of the same name since. The picture is then removed once unused,
    // as other unused media is.
    const id = ctx.ids();
    const added = await insertLocalEmoji(ctx, {
        id,
        instance_id: null,
        account_id: emoji.global ? null : accountId,
        shortcode: emoji.shortcode,
        media_id: picture.id,
        category: emoji.category || null,
        created_at: ctx.clock.now(),
    });
    if (!added) throw new Unprocessable(taken);

    return id;
};
