/**
 * Notifying local users of what others do: mentions, statuses of accounts they asked to be notified
 * of, boosts, follows, follow requests, likes, reactions and edits of statuses they boosted.
 * Undoing any of them, or deleting the status, deletes the notification with it. Followers and
 * boosters of a status can be many, so jobs notify them, a batch at a time.
 * @module
 */
import { z } from "zod";
import { findAccount, findAccounts } from "../accounts/account_queries.ts";
import { batchesOf } from "../db/batches.ts";
import { followsFrom, notifiedFollowerIds } from "../graph/follow_queries.ts";
import { type FollowEvent, isFollowEvent } from "../graph/events.ts";
import {
    isInteractionReceived,
    isLikeEvent,
    isReactionEvent,
    isShareEvent,
} from "../interactions/events.ts";
import { enqueueAll } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import { isNoteEdited, isNotePosted, isNoteReceived } from "../notes/events.ts";
import { findNote, mentionsOf, type NoteRow } from "../notes/note_queries.ts";
import { localSharerIds } from "../notes/share_queries.ts";
import {
    deleteFollowNotifications,
    insertNotifications,
    latestGroupKey,
    mentionNotifiedIds,
} from "./notification_queries.ts";
import type { NotificationCreated } from "./events.ts";
import type { NotificationType } from "./tables.ts";

/** Who was notified, and of which notification. */
export type NotifiedMessage = { readonly accountId: string; readonly notificationId: string };

/** Says a local user was notified, so every process can stream it to them. */
export const notified: Channel<NotifiedMessage> = {
    name: "notifications.created",
    schema: z.object({ accountId: z.string(), notificationId: z.string() }),
};

/** What a notification links, besides who is notified and who did it. */
type Links = {
    readonly noteId?: string;
    readonly shareId?: string;
    readonly likeId?: string;
    readonly reactionId?: string;
    readonly followId?: string;
};

/** The types of notifications that are grouped: Mastodon's, and reactions. */
export const groupedTypes: ReadonlySet<NotificationType> = new Set([
    "favourite",
    "reblog",
    "follow",
    "reaction",
]);

/** How long a group may span, as on Mastodon. */
const groupSpanHours = 12;

const hourMs = 60 * 60 * 1000;

/**
 * The group a new notification of `accountId` goes in, as on Mastodon: one of its type and status,
 * keyed by the hour it started, which notifications join for 12 hours from then. Types that aren't
 * grouped have none.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/notify_service.rb
 */
const groupOf = async (
    ctx: Context,
    accountId: string,
    type: NotificationType,
    noteId: string | undefined,
    now: Date,
) => {
    if (!groupedTypes.has(type)) return null;

    const prefix = `${type}-${noteId ?? ""}`;
    const hour = Math.floor(now.getTime() / hourMs);
    const latest = await latestGroupKey(ctx, accountId, prefix);
    const started = latest === undefined ? undefined : Number(latest.slice(prefix.length + 1));

    return `${prefix}-${started !== undefined && hour < started + groupSpanHours ? started : hour}`;
};

/** Notifies each of `accountIds`, local users, of what `fromId` did, unless it is themselves. */
const notifyAll = async (
    ctx: Context,
    accountIds: readonly string[],
    type: NotificationType,
    fromId: string,
    links: Links,
) => {
    const now = ctx.clock.now();
    const rows = [];
    for (const accountId of accountIds.filter((id) => id !== fromId)) {
        rows.push({
            id: ctx.ids(),
            account_id: accountId,
            type,
            from_account_id: fromId,
            note_id: links.noteId ?? null,
            share_id: links.shareId ?? null,
            like_id: links.likeId ?? null,
            reaction_id: links.reactionId ?? null,
            follow_id: links.followId ?? null,
            group_key: await groupOf(ctx, accountId, type, links.noteId, now),
            created_at: now,
        });
    }

    await insertNotifications(ctx, rows);
    for (const row of rows) {
        const created: NotificationCreated = {
            type: "notifications.created",
            notificationId: row.id,
            accountId: row.account_id,
            notificationType: type,
            fromId,
        };
        await emit(ctx, created);
        await publish(ctx, notified, { accountId: row.account_id, notificationId: row.id });
    }
};

/** The queue that notifies a status's followers of it, or its boosters of an edit. */
export const notifyQueue = "notify";

/** Some of the local users a job notifies of a status, and of what. */
export const NotifyJob = z.object({
    type: z.enum(["status", "update"]),
    noteId: z.string(),
    accountIds: z.array(z.string()),
});

/** How many users a job notifies. */
const notifiedPerJob = 100;

/** Queues jobs that notify `accountIds` of the status `noteId`, a batch at a time. */
const notifyLater = async (
    ctx: Context,
    accountIds: readonly string[],
    type: z.infer<typeof NotifyJob>["type"],
    noteId: string,
) => {
    await enqueueAll(
        ctx,
        batchesOf(accountIds, notifiedPerJob).map((batch) => {
            const payload: z.infer<typeof NotifyJob> = { type, noteId, accountIds: batch };
            return { queue: notifyQueue, payload };
        }),
    );
};

/** Notifies the users in the job of its status, unless the status has gone since. */
export const notifyHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = NotifyJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a notify job");

    const { type, noteId, accountIds } = payload.data;
    await ctx.transaction(async (tx) => {
        const note = await findNote(tx, noteId);
        if (note === undefined) return;

        await notifyAll(tx, accountIds, type, note.account_id, { noteId });
    });
};

/** Notifies the author of `noteId` of what `fromId` did to it, if the status is local. */
const notifyAuthor = async (
    ctx: Context,
    noteId: string,
    type: NotificationType,
    fromId: string,
    links: Links,
) => {
    const note = await findNote(ctx, noteId);
    if (note?.instance_id !== null) return;

    await notifyAll(ctx, [note.account_id], type, fromId, { noteId, ...links });
};

/** The local users that `note` mentions. */
const mentionedLocals = async (ctx: Context, note: NoteRow) => {
    const mentioned = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    return (await findAccounts(ctx, mentioned))
        .filter((account) => account.domain === null)
        .map((account) => account.id);
};

/**
 * Notifies the local users a new status mentions, and, as on Mastodon, the author's followers who
 * asked to be notified, unless it is direct, or a reply to someone else. Followers it mentions are
 * notified of the mention only.
 */
const notifyPosted = async (ctx: Context, note: NoteRow) => {
    const mentioned = await mentionedLocals(ctx, note);
    await notifyAll(ctx, mentioned, "mention", note.account_id, { noteId: note.id });

    const replyToOther = note.in_reply_to_account_id !== null &&
        note.in_reply_to_account_id !== note.account_id;
    if (note.visibility === "direct" || replyToOther) return;

    const followers = await notifiedFollowerIds(ctx, note.account_id);
    const unmentioned = followers.filter((id) => !mentioned.includes(id));
    await notifyLater(ctx, unmentioned, "status", note.id);
};

/**
 * Notifies the local users an edited status mentions for the first time, and the local users who
 * boosted it, as on Mastodon.
 */
const notifyEdited = async (ctx: Context, note: NoteRow) => {
    const notified = await mentionNotifiedIds(ctx, note.id);
    const mentioned = (await mentionedLocals(ctx, note)).filter((id) => !notified.has(id));
    await notifyAll(ctx, mentioned, "mention", note.account_id, { noteId: note.id });

    const sharers = await localSharerIds(ctx, note.id);
    await notifyLater(ctx, sharers, "update", note.id);
};

/**
 * Notifies a local followee of a follow request, or of a follow. Accepting a request deletes its
 * notification instead, as Mastodon does, rather than notifying of a follow they approved. A follow
 * that ended is already gone, with its notification.
 */
const notifyFollow = async (ctx: Context, event: FollowEvent) => {
    const followee = await findAccount(ctx, event.followeeId);
    const [follow] = await followsFrom(ctx, event.followerId, [event.followeeId]);
    if (followee?.domain !== null || follow === undefined) return;

    if (event.type === "graph.follow_requested") {
        await notifyAll(ctx, [followee.id], "follow_request", event.followerId, {
            followId: follow.id,
        });
        return;
    }

    if (await deleteFollowNotifications(ctx, follow.id)) return;
    await notifyAll(ctx, [followee.id], "follow", event.followerId, { followId: follow.id });
};

/** Notifies of a new status, or of an edit. */
const notifyOfNote = async (ctx: Context, noteId: string, edited: boolean) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined) return;

    await (edited ? notifyEdited(ctx, note) : notifyPosted(ctx, note));
};

/** What notifies of a remote interaction, and what it links, by its kind. */
const received = {
    like: (id: string) => ["favourite", { likeId: id }],
    share: (id: string) => ["reblog", { shareId: id }],
    reaction: (id: string) => ["reaction", { reactionId: id }],
} as const satisfies Record<string, (id: string) => readonly [NotificationType, Links]>;

/**
 * Notifies local users of what others did, local or remote. Remote statuses Verso fetched notify no
 * one, since they are often old, and their instances didn't send them to Verso's users.
 */
export const notifyOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isFollowEvent(event)) return await notifyFollow(ctx, event);

    if (isInteractionReceived(event)) {
        const [type, links] = received[event.kind](event.id);
        return await notifyAuthor(ctx, event.noteId, type, event.accountId, links);
    }

    if (isLikeEvent(event) && event.type === "interactions.liked") {
        const links = { likeId: event.likeId };
        return await notifyAuthor(ctx, event.noteId, "favourite", event.accountId, links);
    }
    if (isShareEvent(event) && event.type === "interactions.shared") {
        const links = { shareId: event.shareId };
        return await notifyAuthor(ctx, event.noteId, "reblog", event.accountId, links);
    }
    if (isReactionEvent(event) && event.type === "interactions.reacted") {
        const links = { reactionId: event.reactionId };
        return await notifyAuthor(ctx, event.noteId, "reaction", event.accountId, links);
    }

    if (isNotePosted(event) || isNoteEdited(event)) {
        return await notifyOfNote(ctx, event.noteId, isNoteEdited(event));
    }
    if (isNoteReceived(event) && !event.fetched) {
        return await notifyOfNote(ctx, event.noteId, event.edited);
    }
};
