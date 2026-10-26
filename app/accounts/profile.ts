import { localEmojiIds, setAccountEmojis } from "../emojis/emoji_queries.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { Unprocessable } from "../http/errors.ts";
import type { Fit } from "../kernel/images.ts";
import { scanText } from "../kernel/markup.ts";
import { isMediaProcessed } from "../media/events.ts";
import { describeUpload, uploadPicture } from "../media/uploads.ts";
import {
    type AccountChanges,
    type AccountRow,
    findAccount,
    findAccountByPicture,
    updateLocalAccount,
} from "./account_queries.ts";
import type { ProfileUpdated } from "./events.ts";
import type { ProfileField, Visibility } from "./tables.ts";
import { escapeHtml, textToHtml } from "./text.ts";

/** A picture of a profile: a new image, or a new description of the current one, or both. */
export type PictureChange = {
    readonly file?: Blob;
    /** Alt text. Empty clears it. */
    readonly description?: string;
};

/** The box an avatar is scaled down to fit in, as Mastodon's avatars are. */
const avatarFit: Fit = { width: 400, height: 400 };

/** The box a header is scaled down to fit in, as Mastodon's headers are. */
const headerFit: Fit = { width: 1500, height: 500 };

/** What a user changes about their profile. Omitted fields stay as they are. */
export type ProfileChanges = {
    readonly displayName?: string;
    /** In plain text. */
    readonly note?: string;
    /** All the fields, replacing the old ones, in plain text. Blank ones are dropped. */
    readonly fields?: readonly { readonly name: string; readonly value: string }[];
    readonly locked?: boolean;
    readonly bot?: boolean;
    readonly discoverable?: boolean;
    readonly indexable?: boolean;
    readonly hideCollections?: boolean;
    readonly defaultVisibility?: Visibility;
    readonly defaultSensitive?: boolean;
    /** An ISO 639-1 code, or empty for none. */
    readonly defaultLanguage?: string;
    /** `null` removes the picture, so the account shows its default one. */
    readonly avatar?: PictureChange | null;
    readonly header?: PictureChange | null;
};

const plainField = (name: string, value: string): ProfileField => ({
    name,
    value,
    format: "text/plain",
    name_html: escapeHtml(name),
    value_html: escapeHtml(value),
});

/**
 * Links the local instance's custom emojis used in a local account's display name, bio and field
 * names, replacing the ones it linked before.
 */
const useEmojis = async (ctx: Context, row: AccountRow) => {
    const shortcodes = new Set([
        ...scanText(row.display_name, "text/plain").shortcodes,
        ...scanText(row.note, row.note_format).shortcodes,
        ...row.fields.flatMap((field) => [
            ...scanText(field.name, field.format).shortcodes,
            ...scanText(field.value, field.format).shortcodes,
        ]),
    ]);
    await setAccountEmojis(ctx, row.id, await localEmojiIds(ctx, [...shortcodes]));
};

/**
 * Describes the picture `id` of `accountId` as the change does, if it does. A picture the change
 * replaces is described too, which does nothing, as it is no longer used.
 */
const describeKept = async (
    ctx: Context,
    accountId: string,
    id: string | null,
    change: PictureChange | null | undefined,
) => {
    if (id !== null) await describeUpload(ctx, accountId, id, { description: change?.description });
};

/**
 * The picture `accountId` has as `name` after the change: a new one, uploaded and to be scaled down
 * to fit in `fit`, or `null` if it is removed, or `undefined` if it stays. Refuses a file that isn't
 * an image.
 */
const uploadedPicture = async (
    ctx: Context,
    accountId: string,
    name: "Avatar" | "Header",
    change: PictureChange | null | undefined,
    fit: Fit,
) => {
    if (change === null) return null;
    if (change?.file === undefined) return undefined;

    const row = await uploadPicture(ctx, accountId, {
        file: change.file,
        mediaType: change.file.type,
        description: change.description || undefined,
    }, fit);
    if (row === undefined) throw new Unprocessable(`${name} must be an image`);

    return row.id;
};

/**
 * Updates a local account's profile, rendering the HTML of what was written, finding the custom
 * emojis it uses, and emitting an event for the rest of Verso, even if nothing changed, as Mastodon
 * does. New pictures are processed by a job, and until then the account shows its default ones;
 * the pictures they replace are removed once unused, as other unused media is.
 */
export const updateProfile = async (
    ctx: Context,
    accountId: string,
    changes: ProfileChanges,
): Promise<void> => {
    const set: AccountChanges = {
        display_name: changes.displayName?.trim(),
        locked: changes.locked,
        bot: changes.bot,
        discoverable: changes.discoverable,
        indexable: changes.indexable,
        hide_collections: changes.hideCollections,
        default_visibility: changes.defaultVisibility,
        default_sensitive: changes.defaultSensitive,
        default_language: changes.defaultLanguage,
        // Uploaded before the transaction, which mustn't wait on the file store.
        avatar_id: await uploadedPicture(ctx, accountId, "Avatar", changes.avatar, avatarFit),
        header_id: await uploadedPicture(ctx, accountId, "Header", changes.header, headerFit),
    };

    if (changes.note !== undefined) {
        set.note = changes.note;
        set.note_format = "text/plain";
        set.note_html = textToHtml(changes.note);
    }

    if (changes.fields !== undefined) {
        set.fields = changes.fields
            .map(({ name, value }) => ({ name: name.trim(), value: value.trim() }))
            .filter(({ name, value }) => name !== "" || value !== "")
            .map(({ name, value }) => plainField(name, value));
    }

    await ctx.transaction(async (tx) => {
        const before = await findAccount(tx, accountId);
        if (before?.domain !== null) return;

        await updateLocalAccount(tx, accountId, set);
        await describeKept(tx, accountId, before.avatar_id, changes.avatar);
        await describeKept(tx, accountId, before.header_id, changes.header);
        const after = await findAccount(tx, accountId);
        if (after) await useEmojis(tx, after);

        const unlocked = before.locked && changes.locked === false;
        const event: ProfileUpdated = { type: "accounts.profile_updated", accountId, unlocked };
        await emit(tx, event);
    });
};

/**
 * Tells the rest of Verso that a local profile changed once its new avatar or header finished
 * processing, as until then the account showed its default one, and its followers' instances are
 * only sent it once its pictures are ready.
 */
export const showProcessedPictures = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isMediaProcessed(event)) return;

    // Only local media is processed, so this is a local account.
    const accountId = await findAccountByPicture(ctx, event.mediaId);
    if (accountId === undefined) return;

    const updated: ProfileUpdated = {
        type: "accounts.profile_updated",
        accountId,
        unlocked: false,
    };
    await emit(ctx, updated);
};
