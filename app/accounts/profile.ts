import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type AccountChanges, findAccount, updateLocalAccount } from "./accounts.ts";
import type { ProfileUpdated } from "./events.ts";
import type { ProfileField, Visibility } from "./tables.ts";
import { escapeHtml, textToHtml } from "./text.ts";

/** What a user changes about their profile. Anything left out stays as it is. */
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
 * Changes a local account's profile, making the HTML of what was written, and tells the rest of
 * Verso, even if nothing changed, as Mastodon does.
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

        const unlocked = before.locked && changes.locked === false;
        const event: ProfileUpdated = { type: "accounts.profile_updated", accountId, unlocked };
        await emit(tx, event);
    });
};
