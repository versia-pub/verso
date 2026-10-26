import { localEmojiIds, setAccountEmojis } from "../emojis/emoji_queries.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { scanText } from "../kernel/markup.ts";
import {
    type AccountChanges,
    type AccountRow,
    findAccount,
    updateLocalAccount,
} from "./account_queries.ts";
import type { ProfileUpdated } from "./events.ts";
import type { ProfileField, Visibility } from "./tables.ts";
import { escapeHtml, textToHtml } from "./text.ts";

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
 * Updates a local account's profile, rendering the HTML of what was written, finding the custom
 * emojis it uses, and emitting an event for the rest of Verso, even if nothing changed, as Mastodon
 * does.
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
        const after = await findAccount(tx, accountId);
        if (after) await useEmojis(tx, after);

        const unlocked = before.locked && changes.locked === false;
        const event: ProfileUpdated = { type: "accounts.profile_updated", accountId, unlocked };
        await emit(tx, event);
    });
};
