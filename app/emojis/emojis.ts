/**
 * Custom emojis, which text displays where it has their names, such as `:blobcat:`. Remote
 * instances' emojis are stored as they name them, one per name per instance, as on Mastodon: a
 * newer picture for a name replaces the older one wherever it is used.
 * @see https://versia.pub/extensions/custom-emojis
 * @module
 */
import { NotPermitted, Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import type { Fit } from "../kernel/images.ts";
import { type RemoteMedia, saveRemoteMedia } from "../media/media_queries.ts";
import { updateDescription } from "../media/upload_queries.ts";
import { uploadPicture } from "../media/uploads.ts";
import {
    findLocalEmoji,
    findRemoteEmoji,
    hasUsableEmoji,
    insertEmoji,
    insertLocalEmoji,
    type LocalEmoji,
    updateLocalEmoji,
} from "./emoji_queries.ts";

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

/**
 * A local user who adds, changes or looks up custom emojis, and whether they manage emojis, with
 * the `emojis` permission: global emojis and other users' own emojis.
 */
export type EmojiEditor = {
    readonly accountId: string;
    readonly managesEmojis: boolean;
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

/** What changes about a custom emoji. Omitted fields stay as they are; empty text clears them. */
export type EmojiChanges = Partial<NewEmoji>;

/** The box emojis' pictures are scaled down to fit in, larger than any client displays them. */
const emojiFit: Fit = { width: 128, height: 128 };

const taken = (shortcode: string) =>
    new Unprocessable(`An emoji named ${shortcode} already exists, yours or global`);

const notManager = (description: string) =>
    new NotPermitted(`Only users with the emojis permission ${description}`);

/** Uploads an emoji's picture from `accountId`, which must be an image. */
const uploadEmojiPicture = async (
    ctx: Context,
    accountId: string,
    picture: File,
    description: string | undefined,
) => {
    const row = await uploadPicture(ctx, accountId, {
        file: picture,
        mediaType: picture.type,
        description: description || undefined,
    }, emojiFit);
    if (row === undefined) throw new Unprocessable("The picture must be an image");

    return row;
};

/**
 * Adds a custom emoji from `editor`, and returns its id. Its picture is processed by a job, and
 * until then text doesn't use the emoji. A user can't add one named as one they may already use,
 * their own or a global one, though users may each have one of the same name, as in Versia Server.
 */
export const addEmoji = async (
    ctx: Context,
    editor: EmojiEditor,
    emoji: NewEmoji,
): Promise<string> => {
    if (emoji.global && !editor.managesEmojis) throw notManager("add global emojis");
    if (await hasUsableEmoji(ctx, editor.accountId, emoji.shortcode)) throw taken(emoji.shortcode);

    const picture = await uploadEmojiPicture(
        ctx,
        editor.accountId,
        emoji.picture,
        emoji.description,
    );

    // Someone may have added one of the same name since. The picture is then removed once unused,
    // as other unused media is.
    const id = ctx.ids();
    const added = await insertLocalEmoji(ctx, {
        id,
        instance_id: null,
        account_id: emoji.global ? null : editor.accountId,
        shortcode: emoji.shortcode,
        media_id: picture.id,
        category: emoji.category || null,
        created_at: ctx.clock.now(),
    });
    if (!added) throw taken(emoji.shortcode);

    return id;
};

/**
 * The local emoji `id`, if `editor` may see it: a global one, their own, or any if they manage
 * emojis. Other users' own emojis are theirs alone.
 */
export const findEmojiFor = async (
    ctx: Context,
    editor: EmojiEditor,
    id: string,
): Promise<LocalEmoji | undefined> => {
    const emoji = await findLocalEmoji(ctx, id);
    if (emoji === undefined) return undefined;

    const visible = emoji.account_id === null || emoji.account_id === editor.accountId ||
        editor.managesEmojis;
    return visible ? emoji : undefined;
};

/**
 * Changes the local emoji `id` as `editor` asks, and returns it, or `undefined` if they may not
 * see it. Users change their own emojis; those who manage emojis change any. A global emoji made a
 * user's own becomes the editor's. Renames are held to the same names as new emojis, and statuses
 * that use the emoji keep it, though their text has its old name. A new picture is processed by a
 * job, and until then the emoji isn't shown, as a new one isn't.
 */
export const changeEmoji = async (
    ctx: Context,
    editor: EmojiEditor,
    id: string,
    changes: EmojiChanges,
): Promise<LocalEmoji | undefined> => {
    const emoji = await findEmojiFor(ctx, editor, id);
    if (emoji === undefined) return undefined;
    if (emoji.account_id !== editor.accountId && !editor.managesEmojis) {
        throw notManager("change global emojis");
    }
    if (changes.global && !editor.managesEmojis) throw notManager("make emojis global");

    const owner = changes.global === undefined
        ? emoji.account_id
        : changes.global
        ? null
        : emoji.account_id ?? editor.accountId;
    const shortcode = changes.shortcode ?? emoji.shortcode;
    const renamed = owner !== emoji.account_id || shortcode !== emoji.shortcode;
    if (renamed && await hasUsableEmoji(ctx, owner ?? editor.accountId, shortcode, id)) {
        throw taken(shortcode);
    }

    const description = changes.description ?? emoji.description ?? undefined;
    const picture = changes.picture &&
        await uploadEmojiPicture(ctx, editor.accountId, changes.picture, description);
    if (changes.description !== undefined) {
        await updateDescription(ctx, emoji.media_id, changes.description || null);
    }

    await updateLocalEmoji(ctx, id, {
        account_id: owner,
        shortcode,
        media_id: picture?.id ?? emoji.media_id,
        category: changes.category === undefined ? emoji.category : changes.category || null,
    });

    return await findLocalEmoji(ctx, id);
};
