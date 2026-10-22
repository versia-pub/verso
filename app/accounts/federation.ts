/**
 * Accounts as Versia shows them: local ones to other instances, and other instances' users to
 * Verso.
 * @module
 */
import { formatReference, type Reference, v0_6 } from "@versia/protocol";
import type { CollectionProvider, EntityType, Known } from "../federation/registry.ts";
import type { Context } from "../kernel/context.ts";
import { emojisOfAccounts, type ShownEmoji } from "../emojis/emoji_queries.ts";
import { emojiExtensions, remoteEmojisOf } from "../emojis/versia.ts";
import { remotePicture } from "../media/versia.ts";
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

/** Text as its owner wrote it, and as HTML, so each instance can show whichever it can. */
const text = (format: TextFormat, written: string, html: string): v0_6.ContentFormat => ({
    [format]: { content: written, remote: false },
    "text/html": { content: html, remote: false },
});

/** A picture Verso serves, given by its URL. */
const picture = (url: string): v0_6.ContentFormat => ({
    "image/png": { content: url, remote: true },
});

/** A local account as a Versia User, with the emojis it uses. */
const renderVersiaUser = (
    ctx: Context,
    row: AccountRow,
    emojis: readonly ShownEmoji[],
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
    avatar: picture(ctx.urls.url`/accounts/${row.id}/avatar.png`),
    header: picture(ctx.urls.url`/accounts/${row.id}/header.png`),
    manually_approves_followers: row.locked,
    indexable: row.indexable,
    extensions: emojiExtensions(emojis),
});

/** The local user with this id, or `undefined` if there is none. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return row?.domain === null ? row : undefined;
};

/** The user `reference` points at, local or remote, if Verso has it, without fetching it. */
export const knownUser = async (ctx: Context, reference: Reference): Promise<Known | undefined> => {
    if (reference.host === ctx.urls.domain) {
        const row = await localUser(ctx, reference.id);
        return row && { id: row.id, fetchedAt: null };
    }

    const row = await findRemoteAccountAt(ctx, reference.host, reference.id);
    // A remote account is always saved with when it was fetched.
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
    return renderVersiaUser(ctx, row, emojis);
};

/** A local user's collection of pinned notes, empty until notes can be pinned. */
const emptyCollection: CollectionProvider = async (ctx, id) => {
    const row = await localUser(ctx, id);
    return row && { author: row.id, total: 0, items: [] };
};

/**
 * Users: other instances' ones, kept as remote accounts, and local ones, fetched by other
 * instances, with the notes they wrote and pinned as collections of entities.
 * @see https://versia.pub/entities/user
 */
export const userType: EntityType<v0_6.User> = {
    type: "User",
    schema: v0_6.User,
    // A user has no author, and lives where it came from.
    authority: (_, origin) => origin,
    receive: async (ctx, user, sender) => {
        // Verso chooses which users it keeps, so an instance can't fill it with ones nobody asked
        // for: one sent unasked only updates a user Verso has.
        if (!sender.fetched && !await findRemoteAccount(ctx, sender.instanceId, user.id)) return;

        await saveRemoteAccount(ctx, remoteAccountOf(sender.instanceId, user));
    },
    deleteRemote: (ctx, id, sender) => deleteRemoteAccount(ctx, sender.instanceId, id),
    known: knownUser,
    find: (ctx, id) => localVersiaUser(ctx, id),
    // Who follows whom is the graph's, and what they wrote is the notes', which add those
    // collections.
    collections: { featured: emptyCollection },
};

/**
 * References to the users of `ids` that exist, by id, as Verso puts them in what it sends: a bare
 * id for local users, and the host and id for other instances' ones.
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

/** Text as written, in the first format Verso knows that holds it, or none. */
const writtenText = (formats: v0_6.ContentFormat): { format: TextFormat; text: string } => {
    for (const format of ["text/plain", "text/markdown"] as const) {
        const entry = formats[format];
        if (entry && !entry.remote) return { format, text: entry.content };
    }

    return { format: "text/plain", text: "" };
};

/**
 * Text as Verso keeps it: as written, and as HTML, which is the instance's own if it gave one, kept
 * as it is and sanitised when shown, or else made by `html` from what was written.
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

/** A user on the instance `instanceId`, as Verso keeps it. */
export const remoteAccountOf = (instanceId: string, user: v0_6.User): RemoteAccount => {
    const bio = remoteText(user.bio, renderText);
    const fields = user.fields.map((field): ProfileField => {
        const name = remoteText(field.key, escapeHtml);
        const value = remoteText(field.value, escapeHtml);

        return {
            name: name.text,
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
