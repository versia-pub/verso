/**
 * Likes of statuses, which Mastodon calls favourites.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { isAccountDeleting } from "../accounts/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { visibleNote, visibleOriginal } from "../notes/visibility.ts";
import {
    deleteLike,
    deleteLikeById,
    findRemoteLike,
    insertLike,
    insertRemoteLike,
    uncountLikesBy,
} from "./like_queries.ts";
import { countLike, findNote, type NoteRow } from "../notes/note_queries.ts";
import type { InteractionReceived, LikeEvent } from "./events.ts";
import type { LikeKind } from "./tables.ts";

/**
 * Likes a status for `accountId`, or the status a boost boosts, and increments its like count,
 * unless the account already likes it. Returns the status as it is now, or `undefined` if there is
 * none `accountId` may see.
 */
export const like = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleOriginal(tx, noteId, accountId);
        if (note === undefined) return undefined;

        const added = await insertLike(tx, accountId, note.id);
        if (added) {
            await countLike(tx, note.id, 1);

            const event: LikeEvent = {
                type: "interactions.liked",
                likeId: added.id,
                accountId,
                noteId: note.id,
            };
            await emit(tx, event);
        }

        return await findNote(tx, note.id);
    });

/**
 * Undoes `accountId`'s like of a status, or of the status a boost boosts, and decrements the like
 * count. Returns the status as it is now, or `undefined` if there is none. As on Mastodon, a status
 * it liked can be unliked even if it may no longer see it, and one it didn't like only if it may
 * see it. Local users never dislike statuses, so there is no dislike to undo.
 */
export const unlike = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const liked = (await findNote(tx, noteId))?.reblog_of_id ?? noteId;

        const removed = await deleteLike(tx, accountId, liked);
        if (removed === undefined) return await visibleNote(tx, liked, accountId);

        await countLike(tx, liked, -1);

        const event: LikeEvent = {
            type: "interactions.unliked",
            likeId: removed.id,
            accountId,
            noteId: liked,
        };
        await emit(tx, event);

        return await findNote(tx, liked);
    });

/** A remote like or dislike of a status, by one of the remote instance's users. */
export type RemoteLike = {
    readonly accountId: string;
    readonly noteId: string;
    readonly kind: LikeKind;
    readonly instanceId: string;
    readonly remoteId: string;
    readonly createdAt: Date;
};

/**
 * Stores a remote like or dislike, replacing the account's other one of the status if it has one,
 * as an account can't like and dislike a status at once. Only likes are counted, and only they are
 * emitted. One Verso already has is left unchanged.
 */
export const keepRemoteLike = async (ctx: Context, like: RemoteLike): Promise<void> => {
    if (await findRemoteLike(ctx, like.instanceId, like.remoteId)) return;

    const replaced = await deleteLike(ctx, like.accountId, like.noteId);
    if (replaced?.kind === "like") await countLike(ctx, like.noteId, -1);

    const id = ctx.ids();
    await insertRemoteLike(ctx, {
        id,
        account_id: like.accountId,
        note_id: like.noteId,
        kind: like.kind,
        instance_id: like.instanceId,
        remote_id: like.remoteId,
        created_at: like.createdAt,
    });
    if (like.kind !== "like") return;

    await countLike(ctx, like.noteId, 1);

    const event: InteractionReceived = {
        type: "interactions.received",
        kind: "like",
        id,
        accountId: like.accountId,
        noteId: like.noteId,
    };
    await emit(ctx, event);
};

/** Undoes a remote like or dislike, which a Delete said is gone, if Verso has it. */
export const undoRemoteLike = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> => {
    const like = await findRemoteLike(ctx, instanceId, remoteId);
    const removed = like && await deleteLikeById(ctx, like.id);
    if (removed?.kind === "like") await countLike(ctx, removed.note_id, -1);
};

/**
 * Decrements the like counts that depend on an account about to be deleted, before its likes are
 * deleted with it.
 */
export const uncountLikesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountLikesBy(ctx, event.accountId);
};
