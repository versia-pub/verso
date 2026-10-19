/**
 * Accounts as Versia shows them: local ones to other instances, and other instances' users to
 * Verso.
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import type { Context } from "../kernel/context.ts";
import type { RemoteMedia } from "../media/media.ts";
import {
    type AccountRow,
    findAccount,
    findRemoteAccount,
    findRemoteAccountAt,
} from "./accounts.ts";
import { deleteRemoteAccount, type RemoteAccount, saveRemoteAccount } from "./remote.ts";
import type { ProfileField, TextFormat } from "./tables.ts";
import { escapeHtml, textToHtml } from "./text.ts";

/** Text as its owner wrote it, and as HTML, so each instance can show whichever it can. */
const text = (format: TextFormat, written: string, html: string): v0_6.ContentFormat => ({
    [format]: { content: written, remote: false },
    "text/html": { content: html, remote: false },
});

/** A picture Verso serves, given by its URL. */
const picture = (url: string): v0_6.ContentFormat => ({
    "image/png": { content: url, remote: true },
});

/** A local account as a Versia User. */
const renderVersiaUser = (ctx: Context, row: AccountRow): v0_6.User => ({
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
});

/** The local user with this id, or `undefined` if there is none. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return row?.domain === null ? row : undefined;
};

/**
 * A local user's collection, empty until the notes and follows that fill it arrive in step 8.
 * Limits from 1 to 40 must work; step 8 decides what to do with others.
 */
const emptyCollection: CollectionProvider = async (ctx, id) => {
    const row = await localUser(ctx, id);
    return row && { author: row.id, total: 0, items: [] };
};

/**
 * Users: other instances' ones, kept as remote accounts, and local ones, fetched by other instances, with their collections, the notes they wrote and
 * pinned as entities, and who follows them and who they follow as references.
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
    known: async (ctx, reference) => {
        if (reference.host === ctx.urls.domain) {
            const row = await localUser(ctx, reference.id);
            return row && { id: row.id, fetchedAt: null };
        }

        const row = await findRemoteAccountAt(ctx, reference.host, reference.id);
        // A remote account is always saved with when it was fetched.
        return row && { id: row.id, fetchedAt: row.fetched_at ?? new Date(0) };
    },
    find: async (ctx, id) => {
        const row = await localUser(ctx, id);
        return row && renderVersiaUser(ctx, row);
    },
    collections: {
        outbox: emptyCollection,
        featured: emptyCollection,
        followers: emptyCollection,
        following: emptyCollection,
    },
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
 * as it is and sanitised when shown. Markdown without HTML is shown as plain text, until Verso
 * renders Markdown.
 */
const remoteText = (
    formats: v0_6.ContentFormat | null | undefined,
    html: (text: string) => string,
) => {
    const written = writtenText(formats ?? {});
    const given = formats?.["text/html"];

    return { ...written, html: given && !given.remote ? given.content : html(written.text) };
};

/** Pictures clients can be counted on to show. */
const pictureTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The first version of a picture that clients can show, at a web address. */
const remotePicture = (formats: v0_6.ContentFormat | null | undefined): RemoteMedia | null => {
    for (const [mediaType, entry] of Object.entries(formats ?? {})) {
        if (!entry.remote || !pictureTypes.has(mediaType)) continue;
        if (!v0_6.WebUrl.safeParse(entry.content).success) continue;

        return {
            url: entry.content,
            mediaType,
            size: entry.size ?? undefined,
            sha256: entry.hash?.toLowerCase(),
            width: entry.width ?? undefined,
            height: entry.height ?? undefined,
            thumbhash: entry.thumbhash ?? undefined,
            description: entry.description ?? undefined,
        };
    }

    return null;
};

/** A user on the instance `instanceId`, as Verso keeps it. */
export const remoteAccountOf = (instanceId: string, user: v0_6.User): RemoteAccount => {
    const bio = remoteText(user.bio, textToHtml);
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
    };
};
