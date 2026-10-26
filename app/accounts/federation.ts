/**
 * Accounts as Versia renders them: local ones for remote instances, and remote users for Verso.
 * @module
 */
import { formatReference, type Reference, v0_6 } from "@versia/protocol";
import type { EntityType, Known } from "../federation/registry.ts";
import type { Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import { emojisOfAccounts, type ShownEmoji } from "../emojis/emoji_queries.ts";
import { emojiExtensions, remoteEmojisOf } from "../emojis/versia.ts";
import { findMedia } from "../media/media_queries.ts";
import { remotePicture, versiaFile } from "../media/versia.ts";
import {
    type AccountRow,
    findAccount,
    findAccounts,
    findRemoteAccount,
    findRemoteAccountAt,
} from "./account_queries.ts";
import { deleteRemoteAccount, type RemoteAccount, saveRemoteAccount } from "./remote.ts";
import type { ProfileField, TextFormat } from "./tables.ts";
import { escapeHtml } from "./text.ts";
import { renderText } from "../kernel/markup.ts";

/** Text as its owner wrote it, and as HTML, so each instance can display whichever it supports. */
const text = (format: TextFormat, written: string, html: string): v0_6.ContentFormat => ({
    [format]: { content: written, remote: false },
    "text/html": { content: html, remote: false },
});

/** A default picture served by Verso, given by its URL. */
const picture = (url: string): v0_6.ContentFormat => ({
    "image/png": { content: url, remote: true },
});

/**
 * Whether the local account `id` has an avatar or header still being processed, so it isn't
 * finished changing and isn't sent to remote instances yet.
 */
export const hasPicturesProcessing = async (ctx: Context, id: string): Promise<boolean> => {
    const row = await localUser(ctx, id);
    const pictures = [row?.avatar_id ?? null, row?.header_id ?? null];

    for (const picture of pictures) {
        if (picture === null) continue;
        if ((await findMedia(ctx, picture))?.processed_at === null) return true;
    }

    return false;
};

/** A local account's picture `id`, once processed, or else its default one at `fallback`. */
const ownPicture = async (ctx: Context, id: string | null, fallback: string) => {
    const row = id === null ? undefined : await findMedia(ctx, id);
    return (row && versiaFile(ctx, row)) ?? picture(fallback);
};

/** A local account as a Versia User, with the custom emojis it uses and its pictures. */
const renderVersiaUser = (
    ctx: Context,
    row: AccountRow,
    emojis: readonly ShownEmoji[],
    pictures: { readonly avatar: v0_6.ContentFormat; readonly header: v0_6.ContentFormat },
): v0_6.User => ({
    type: "User",
    id: row.id,
    created_at: row.created_at.toISOString(),
    username: row.username,
    display_name: row.display_name === "" ? undefined : row.display_name,
    bio: row.note === "" ? undefined : text(row.note_format, row.note, row.note_html),
    fields: row.fields.map((field) => ({
        key: text(field.format, field.name, field.name_html),
        value: text(field.format, field.value, field.value_html),
    })),
    avatar: pictures.avatar,
    header: pictures.header,
    manually_approves_followers: row.locked,
    indexable: row.indexable,
    extensions: emojiExtensions(ctx, emojis),
});

/** The local user with this id, or `undefined` if there is none. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return row?.domain === null ? row : undefined;
};

/** The user that `reference` points at, local or remote, if Verso has it, without fetching it. */
export const knownUser = async (ctx: Context, reference: Reference): Promise<Known | undefined> => {
    if (reference.host === ctx.urls.domain) {
        const row = await localUser(ctx, reference.id);
        return row && { id: row.id, fetchedAt: null };
    }

    const row = await findRemoteAccountAt(ctx, reference.host, reference.id);
    // A remote account is always saved with the time it was fetched.
    return row && { id: row.id, fetchedAt: row.fetched_at ?? new Date(0) };
};

/** The local user with this id as a Versia User, or `undefined` if there is none. */
export const localVersiaUser = async (
    ctx: Context,
    id: string,
): Promise<v0_6.User | undefined> => {
    const row = await localUser(ctx, id);
    if (row === undefined) return undefined;

    const emojis = (await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? [];
    return renderVersiaUser(ctx, row, emojis, {
        avatar: await ownPicture(ctx, row.avatar_id, ctx.urls.url`/accounts/${row.id}/avatar.png`),
        header: await ownPicture(ctx, row.header_id, ctx.urls.url`/accounts/${row.id}/header.png`),
    });
};

/**
 * Users: remote ones, stored as remote accounts, and local ones, fetched by remote instances. Their
 * collections are added by the modules that own them: who follows whom by the graph module, and
 * what they wrote and pinned by the notes module.
 * @see https://versia.pub/entities/user
 */
export const userType: EntityType<v0_6.User> = {
    type: "User",
    schema: v0_6.User,
    // A profile can change back to what it was.
    resendable: true,
    // A user has no author, and lives where it came from.
    authority: (_, origin) => origin,
    receive: async (ctx, user, sender) => {
        // Verso chooses which users it stores, so an instance can't fill it with users nobody
        // requested: a user sent unsolicited only updates a user Verso already has.
        if (!sender.fetched && !await findRemoteAccount(ctx, sender.instanceId, user.id)) return;

        await saveRemoteAccount(ctx, remoteAccountOf(sender.instanceId, user));
    },
    deleteRemote: (ctx, id, sender) => deleteRemoteAccount(ctx, sender.instanceId, id),
    known: knownUser,
    find: (ctx, id) => localVersiaUser(ctx, id),
};

/**
 * References to the users of `ids` that exist, by id, as Verso puts them in what it sends: a bare
 * id for local users, and the host and id for remote ones.
 */
export const userReferenceMap = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, string>> => {
    const references = new Map<string, string>();

    for (const row of await findAccounts(ctx, ids)) {
        if (row.domain === null) {
            references.set(row.id, row.id);
            continue;
        }

        if (row.remote_id === null) throw new Error(`Remote account ${row.id} has no remote id`);
        references.set(
            row.id,
            formatReference({ host: row.domain, id: row.remote_id }, ctx.urls.domain),
        );
    }

    return references;
};

/** References to the users of `ids` that exist, in the order of `ids`. */
export const userReferences = async (ctx: Context, ids: readonly string[]): Promise<string[]> => {
    const references = await userReferenceMap(ctx, ids);
    return ids.flatMap((id) => references.get(id) ?? []);
};

/** Text as written, in the first format Verso supports that contains it, or none. */
const writtenText = (formats: v0_6.ContentFormat): { format: TextFormat; text: string } => {
    for (const format of ["text/plain", "text/markdown"] as const) {
        const entry = formats[format];
        if (entry && !entry.remote) return { format, text: entry.content };
    }

    return { format: "text/plain", text: "" };
};

/**
 * Text as Verso stores it: as written, and as HTML. The HTML is the remote instance's own if it
 * gave one, stored as is and sanitised when displayed, or else generated by `html` from what was
 * written.
 */
export const remoteText = (
    formats: v0_6.ContentFormat | null | undefined,
    html: (text: string, format: TextFormat) => string,
): { format: TextFormat; text: string; html: string } => {
    const written = writtenText(formats ?? {});
    const given = formats?.["text/html"];

    return {
        ...written,
        html: given && !given.remote ? given.content : html(written.text, written.format),
    };
};

/** A user on the instance `instanceId`, as Verso stores it. */
export const remoteAccountOf = (instanceId: string, user: v0_6.User): RemoteAccount => {
    const bio = remoteText(user.bio, renderText);
    const fields = user.fields.map((field): ProfileField => {
        const name = remoteText(field.key, escapeHtml);
        const value = remoteText(field.value, escapeHtml);

        return {
            // Clients display a field's name as text, so a name given only as HTML is displayed as
            // its text.
            name: name.text || textOfHtml(name.html).replaceAll(/\s+/g, " ").trim(),
            value: value.text,
            // Each is in the format of its name, which is nearly always the same as its value's.
            format: name.format,
            name_html: name.html,
            value_html: value.html,
        };
    });

    return {
        instanceId,
        remoteId: user.id,
        createdAt: new Date(user.created_at),
        profile: {
            username: user.username,
            display_name: user.display_name ?? "",
            note: bio.text,
            note_format: bio.format,
            note_html: bio.html,
            fields,
            locked: user.manually_approves_followers,
            indexable: user.indexable,
        },
        avatar: remotePicture(user.avatar),
        header: remotePicture(user.header),
        emojis: remoteEmojisOf(user.extensions),
    };
};
