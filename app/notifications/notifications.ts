/**
 * Notifying local users of what others do: mentions, statuses of accounts they asked to be notified
 * of, boosts, follows, follow requests, likes, reactions and edits of statuses they boosted.
 * Undoing any of them, or deleting the status, deletes the notification with it.
 * @module
 */
import { findAccount, findAccounts } from "../accounts/account_queries.ts";
import { followsFrom, notifiedFollowerIds } from "../graph/follow_queries.ts";
import { type FollowEvent, isFollowEvent } from "../graph/events.ts";
import { isLikeEvent, isReactionEvent, isShareEvent } from "../interactions/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { isNoteEdited, isNotePosted } from "../notes/events.ts";
import { findNote, mentionsOf, type NoteRow } from "../notes/note_queries.ts";
import { localSharerIds } from "../notes/share_queries.ts";
import {
    deleteFollowNotifications,
    insertNotifications,
    mentionNotifiedIds,
} from "./notification_queries.ts";
import type { NotificationType } from "./tables.ts";

/** What a notification links, besides who is notified and who did it. */
type Links = {
    readonly noteId?: string;
    readonly shareId?: string;
    readonly likeId?: string;
    readonly reactionId?: string;
    readonly followId?: string;
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
    const rows = accountIds.filter((id) => id !== fromId).map((accountId) => ({
        id: ctx.ids(),
        account_id: accountId,
        type,
        from_account_id: fromId,
        note_id: links.noteId ?? null,
        share_id: links.shareId ?? null,
        like_id: links.likeId ?? null,
        reaction_id: links.reactionId ?? null,
        follow_id: links.followId ?? null,
        created_at: now,
    }));

    await insertNotifications(ctx, rows);
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
    await notifyAll(ctx, unmentioned, "status", note.account_id, { noteId: note.id });
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
    await notifyAll(ctx, sharers, "update", note.account_id, { noteId: note.id });
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

/** Notifies local users of what others did. */
export const notifyOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isFollowEvent(event)) return await notifyFollow(ctx, event);

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

    if (!isNotePosted(event) && !isNoteEdited(event)) return;
    const note = await findNote(ctx, event.noteId);
    if (note === undefined) return;

    await (isNotePosted(event) ? notifyPosted(ctx, note) : notifyEdited(ctx, note));
};
