import { setAccountEmojis, usableEmojiIds } from "../emojis/emoji_queries.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { Unprocessable } from "../http/errors.ts";
import type { Fit } from "../kernel/images.ts";
import { scanText } from "../kernel/markup.ts";
import { isMediaProcessed } from "../media/events.ts";
import { describeUpload, isPlayable, upload, uploadPicture } from "../media/uploads.ts";
import {
    type AccountChanges,
    type AccountRow,
    findAccount,
    findAccountByPicture,
    replaceDecorationKind,
    updateLocalAccount,
} from "./account_queries.ts";
import type { ProfileUpdated } from "./events.ts";
import type { Visibility } from "../kernel/visibility.ts";
import type { DecorationKind, ProfileField } from "./tables.ts";
import { escapeHtml, textToHtml } from "./text.ts";

/** A picture of a profile: a new image, or a new description of the current one, or both. */
export type PictureChange = {
    readonly file?: Blob;
    /** Alt text. Empty clears it. */
    readonly description?: string;
};

/** Mastodon's size for avatars: they are scaled down to fit this box. */
const avatarFit: Fit = { width: 400, height: 400 };

/** Mastodon's size for headers: they are scaled down to fit this box. */
const headerFit: Fit = { width: 1500, height: 500 };

/** What the decorations that are images are called in errors, and the box they are scaled to fit. */
const decorationImages = {
    // The avatar goes in the inner 80% of an overlay, and avatars fit 400x400.
    avatar_overlay: { name: "Avatar overlay", fit: { width: 500, height: 500 } },
    avatar_mask: { name: "Avatar mask", fit: { width: 400, height: 400 } },
    background: { name: "Background", fit: { width: 1920, height: 1080 } },
} as const;

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
    readonly showMedia?: boolean;
    readonly showMediaReplies?: boolean;
    readonly showFeatured?: boolean;
    /** The domains whose pages may credit the account, all of them, replacing the old ones. */
    readonly attributionDomains?: readonly string[];
    readonly defaultVisibility?: Visibility;
    readonly defaultSensitive?: boolean;
    /** An ISO 639-1 code, or empty for none. */
    readonly defaultLanguage?: string;
    /** By BCP 47 language tag, in plain text, replacing all of them. Blank ones are dropped. */
    readonly pronouns?: Readonly<Record<string, string>>;
    /** As `YYYY-MM-DD` or `--MM-DD`, or empty for none. */
    readonly birthday?: string;
    /** In plain text, or empty for none. */
    readonly location?: string;
    /** An IANA name, or empty for none. */
    readonly timezone?: string;
    /** All the overlays of the avatar, replacing the old ones, topmost first. `null` removes them. */
    readonly avatarOverlays?: readonly Blob[] | null;
    /** `null` removes the decoration. */
    readonly avatarMask?: Blob | null;
    readonly background?: Blob | null;
    /** A sound file. */
    readonly audio?: Blob | null;
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
 * Links the custom emojis used in a local account's display name, bio and fields that it may use,
 * replacing the ones it linked before.
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
    await setAccountEmojis(ctx, row.id, await usableEmojiIds(ctx, row.id, [...shortcodes]));
};

/**
 * Gives the picture `id`, which `accountId` had before the change, the description the change sets,
 * if it sets one. A new picture is described when it is uploaded, so this describes the picture the
 * account keeps. One the change replaces is described too, which is harmless, as it is no longer
 * shown.
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
 * to fit in `fit`, or `null` if it is removed, or `undefined` if it stays. Refuses a file that
 * isn't an image.
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
 * The decorations of the kind `kind` that `accountId` has after the change: new ones, uploaded, or
 * none if they are removed, or `undefined` if they stay. Refuses a file that isn't an image, or for
 * audio, isn't audio.
 */
const uploadedDecorations = async (
    ctx: Context,
    accountId: string,
    kind: DecorationKind,
    change: readonly Blob[] | Blob | null | undefined,
): Promise<string[] | undefined> => {
    if (change === undefined) return undefined;

    const files = change === null ? [] : change instanceof Blob ? [change] : change;
    const ids = [];

    for (const file of files) {
        if (kind === "audio") {
            if (!file.type.startsWith("audio/") || !isPlayable(file.type)) {
                throw new Unprocessable("Audio must be audio");
            }

            ids.push((await upload(ctx, accountId, { file, mediaType: file.type })).id);
            continue;
        }

        const { name, fit } = decorationImages[kind];
        const row = await uploadPicture(ctx, accountId, { file, mediaType: file.type }, fit);
        if (row === undefined) throw new Unprocessable(`${name} must be an image`);

        ids.push(row.id);
    }

    return ids;
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
        updated_at: ctx.clock.now(),
        display_name: changes.displayName?.trim(),
        locked: changes.locked,
        bot: changes.bot,
        discoverable: changes.discoverable,
        indexable: changes.indexable,
        hide_collections: changes.hideCollections,
        show_media: changes.showMedia,
        show_media_replies: changes.showMediaReplies,
        show_featured: changes.showFeatured,
        attribution_domains: changes.attributionDomains && [...changes.attributionDomains],
        default_visibility: changes.defaultVisibility,
        default_sensitive: changes.defaultSensitive,
        default_language: changes.defaultLanguage,
        birthday: changes.birthday === undefined ? undefined : changes.birthday || null,
        location: changes.location === undefined ? undefined : changes.location.trim() || null,
        timezone: changes.timezone === undefined ? undefined : changes.timezone || null,
        // Uploaded before the transaction, which mustn't wait on the file store.
        avatar_id: await uploadedPicture(ctx, accountId, "Avatar", changes.avatar, avatarFit),
        header_id: await uploadedPicture(ctx, accountId, "Header", changes.header, headerFit),
    };

    const decorations = {
        avatar_overlay: await uploadedDecorations(
            ctx,
            accountId,
            "avatar_overlay",
            changes.avatarOverlays,
        ),
        avatar_mask: await uploadedDecorations(ctx, accountId, "avatar_mask", changes.avatarMask),
        background: await uploadedDecorations(ctx, accountId, "background", changes.background),
        audio: await uploadedDecorations(ctx, accountId, "audio", changes.audio),
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

    if (changes.pronouns !== undefined) {
        set.pronouns = Object.fromEntries(
            Object.entries(changes.pronouns)
                .map(([tag, pronouns]) => [tag, pronouns.trim()])
                .filter(([, pronouns]) => pronouns !== ""),
        );
    }

    await ctx.transaction(async (tx) => {
        const before = await findAccount(tx, accountId);
        if (before?.domain !== null) return;

        await updateLocalAccount(tx, accountId, set);
        for (const [kind, ids] of Object.entries(decorations) as [DecorationKind, string[]?][]) {
            if (ids !== undefined) await replaceDecorationKind(tx, accountId, kind, ids);
        }

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
 * Tells the rest of Verso that a local profile changed once its new avatar, header or decoration
 * finished processing, as until then the account showed its default picture or none, and its
 * followers' instances are only sent it once its pictures are ready.
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
