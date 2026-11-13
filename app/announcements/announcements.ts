/**
 * Announcements: what the instance's admins tell its users, through `verso admin announcements`.
 * One is shown from when it is published, or from when it was scheduled for, until the event it
 * announces ends. They aren't federated. Each one published, changed or taken down is published
 * on {@link announcementChanged} too, so that users' apps are told on their streams.
 * @see https://docs.joinmastodon.org/methods/announcements/
 * @module
 */
import { z } from "zod";
import type { AccountRow } from "../accounts/account_queries.ts";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { userUri } from "../accounts/render.ts";
import { fetchBudget } from "../federation/resolver.ts";
import type { Context } from "../kernel/context.ts";
import { linksIn, renderText, scanText } from "../kernel/markup.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import { findNotes } from "../notes/note_queries.ts";
import { resolveEntityAt } from "../search/urls.ts";
import {
    type AnnouncementRow,
    deleteAnnouncement,
    dueAnnouncementIds,
    endedAnnouncementIds,
    findAnnouncement,
    findPublishedAnnouncement,
    insertAnnouncement,
    insertDismissal,
    listAnnouncements,
    updateAnnouncement,
} from "./announcement_queries.ts";

/** Which announcement was published or changed, or with `published` false, taken down. */
export type AnnouncementChangedMessage = { readonly id: string; readonly published: boolean };

/** Says an announcement was published, changed or taken down, so every process can stream it. */
export const announcementChanged: Channel<AnnouncementChangedMessage> = {
    name: "announcements.changed",
    schema: z.object({ id: z.string(), published: z.boolean() }),
};

/** An announcement, as an admin writes it. */
export type AnnouncementInput = {
    /** In plain text. */
    readonly text: string;
    /** When the event it announces starts and ends, both or neither. */
    readonly startsAt: Date | null;
    readonly endsAt: Date | null;
    readonly allDay: boolean;
    /** When to publish it, or `null` for at once. */
    readonly scheduledAt: Date | null;
};

/** The result of changing an announcement: the announcement, or why it wasn't changed. */
export type AnnouncementResult = AnnouncementRow | "missing" | { readonly invalid: string };

/** How long saving an announcement may spend fetching the statuses it links to. */
const linksMs = 15_000;

/** Why `input` isn't an announcement by Mastodon's checks, or `undefined` if it is one. */
const problemWith = (input: AnnouncementInput) => {
    if (input.text.trim() === "") return "The text can't be empty";
    if ((input.startsAt === null) !== (input.endsAt === null)) {
        return "An event needs both when it starts and when it ends";
    }
    return undefined;
};

/**
 * What `text` mentions and links to, and its HTML. Only the accounts Verso has are mentioned.
 * Linked statuses are fetched if Verso doesn't have them, and kept if they are public or unlisted.
 */
const derived = async (ctx: Context, text: string) => {
    const found = scanText(text, "text/plain");
    const accounts = new Map<string, AccountRow>();
    for (const { username, domain } of found.mentions) {
        const address = parseAddress(ctx, domain === null ? username : `${username}@${domain}`);
        const row = address && await findAccountByAddress(ctx, address, { fetch: false });
        if (row) accounts.set(`${username}@${domain}`.toLowerCase(), row);
    }

    const budget = fetchBudget(20, ctx.clock.now().getTime() + linksMs);
    const noteIds = new Set<string>();
    for (const url of linksIn(text, "text/plain")) {
        const entity = await resolveEntityAt(ctx, url, budget);
        if (entity?.type === "Note") noteIds.add(entity.id);
    }

    const notes = await findNotes(ctx, [...noteIds]);
    const shown = new Set(
        notes.filter((note) => note.visibility === "public" || note.visibility === "unlisted")
            .map((note) => note.id),
    );

    const html = renderText(text, "text/plain", {
        mention: (mention) => {
            const row = accounts.get(`${mention.username}@${mention.domain}`.toLowerCase());
            return row && userUri(ctx, row);
        },
        hashtag: (tag) => ctx.urls.url`/tags/${tag.toLowerCase()}`,
    });

    return {
        text,
        content_html: html,
        account_ids: [...new Set([...accounts.values()].map((row) => row.id))],
        note_ids: [...noteIds].filter((id) => shown.has(id)),
    };
};

const changed = (ctx: Context, id: string, published: boolean) =>
    publish(ctx, announcementChanged, { id, published });

/**
 * Makes an announcement, published at once unless it is scheduled for later. Returns it, or why it
 * can't be made.
 */
export const createAnnouncement = async (
    ctx: Context,
    input: AnnouncementInput,
): Promise<AnnouncementRow | { readonly invalid: string }> => {
    const problem = problemWith(input);
    if (problem !== undefined) return { invalid: problem };

    const now = ctx.clock.now();
    const due = input.scheduledAt === null || input.scheduledAt <= now;
    const row: AnnouncementRow = {
        id: ctx.ids(),
        ...await derived(ctx, input.text),
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        all_day: input.allDay,
        scheduled_at: due ? null : input.scheduledAt,
        published_at: due ? now : null,
        created_at: now,
        updated_at: now,
    };

    await ctx.transaction(async (tx) => {
        await insertAnnouncement(tx, row);
        if (due) await changed(tx, row.id, true);
    });

    return row;
};

/**
 * Changes the announcement `id` as `changes` say, leaving out what they leave out. A published one
 * is streamed again.
 */
export const changeAnnouncement = async (
    ctx: Context,
    id: string,
    changes: Partial<AnnouncementInput>,
): Promise<AnnouncementResult> => {
    const row = await findAnnouncement(ctx, id);
    if (row === undefined) return "missing";

    const input: AnnouncementInput = {
        text: changes.text ?? row.text,
        startsAt: changes.startsAt === undefined ? row.starts_at : changes.startsAt,
        endsAt: changes.endsAt === undefined ? row.ends_at : changes.endsAt,
        allDay: changes.allDay ?? row.all_day,
        // One published already isn't scheduled.
        scheduledAt: changes.scheduledAt === undefined || row.published_at !== null
            ? row.scheduled_at
            : changes.scheduledAt,
    };
    const problem = problemWith(input);
    if (problem !== undefined) return { invalid: problem };

    const text = changes.text === undefined ? {} : await derived(ctx, input.text);

    return await ctx.transaction(async (tx) => {
        const updated = await updateAnnouncement(tx, id, {
            ...text,
            starts_at: input.startsAt,
            ends_at: input.endsAt,
            all_day: input.allDay,
            scheduled_at: input.scheduledAt,
            updated_at: ctx.clock.now(),
        });
        if (updated === undefined) return "missing";

        if (updated.published_at !== null) await changed(tx, id, true);
        return updated;
    });
};

/** Publishes the announcement `id`, unless it is published already. */
export const publishAnnouncement = (ctx: Context, id: string): Promise<AnnouncementResult> =>
    ctx.transaction(async (tx) => {
        const row = await findAnnouncement(tx, id);
        if (row === undefined) return "missing";
        if (row.published_at !== null) return row;

        const now = ctx.clock.now();
        const updated = await updateAnnouncement(tx, id, {
            published_at: now,
            scheduled_at: null,
            updated_at: now,
        });
        if (updated === undefined) return "missing";

        await changed(tx, id, true);
        return updated;
    });

/**
 * Takes the announcement `id` down, until it is published again, unless it is down already. One
 * scheduled for later isn't published when due.
 */
export const unpublishAnnouncement = (ctx: Context, id: string): Promise<AnnouncementResult> =>
    ctx.transaction(async (tx) => {
        const row = await findAnnouncement(tx, id);
        if (row === undefined) return "missing";
        if (row.published_at === null && row.scheduled_at === null) return row;
        if (row.published_at === null) {
            return await updateAnnouncement(tx, id, {
                scheduled_at: null,
                updated_at: ctx.clock.now(),
            }) ?? "missing";
        }

        const updated = await updateAnnouncement(tx, id, {
            published_at: null,
            scheduled_at: null,
            updated_at: ctx.clock.now(),
        });
        if (updated === undefined) return "missing";

        await changed(tx, id, false);
        return updated;
    });

/** Deletes the announcement `id`. Returns whether there was one. */
export const removeAnnouncement = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        const row = await deleteAnnouncement(tx, id);
        if (row === undefined) return false;

        if (row.published_at !== null) await changed(tx, id, false);
        return true;
    });

/** The queue of the task that publishes announcements when due, and takes them down. */
export const announcementsQueue = "announcements";

/**
 * Publishes the announcements scheduled for by now, and takes down those whose events ended by now.
 * Mastodon does this every minute. Unlike Mastodon, Verso tells apps that those taken down are
 * gone.
 */
export const publishDueAnnouncements = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();
    for (const id of await dueAnnouncementIds(ctx, now)) await publishAnnouncement(ctx, id);
    for (const id of await endedAnnouncementIds(ctx, now)) await unpublishAnnouncement(ctx, id);
};

/**
 * Dismisses the published announcement `id` for `accountId`, a local user. Returns whether there is
 * one.
 */
export const dismissAnnouncement = (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        if (await findPublishedAnnouncement(tx, id) === undefined) return false;

        await insertDismissal(tx, accountId, id);
        return true;
    });

/** An announcement as `verso admin announcements` prints it. */
export type AdminAnnouncement = {
    readonly id: string;
    readonly text: string;
    readonly published: boolean;
    readonly published_at: Date | null;
    readonly scheduled_at: Date | null;
    readonly starts_at: Date | null;
    readonly ends_at: Date | null;
    readonly all_day: boolean;
    readonly created_at: Date;
    readonly updated_at: Date;
};

/** `row` as `verso admin announcements` prints it. */
export const announcementForAdmin = (row: AnnouncementRow): AdminAnnouncement => ({
    id: row.id,
    text: row.text,
    published: row.published_at !== null,
    published_at: row.published_at,
    scheduled_at: row.scheduled_at,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    created_at: row.created_at,
    updated_at: row.updated_at,
});

/** Every announcement, published or not, the first made first, as admins see them. */
export const announcementsForAdmin = async (
    ctx: Context,
): Promise<AdminAnnouncement[]> => (await listAnnouncements(ctx)).map(announcementForAdmin);
