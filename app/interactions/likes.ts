/**
 * Likes of notes, which Mastodon calls favourites.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { isAccountDeleting } from "../accounts/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { visibleNote } from "../notes/notes.ts";
import {
    countLike,
    deleteLike,
    deleteLikeById,
    findRemoteLike,
    insertLike,
    insertRemoteLike,
    uncountLikesBy,
} from "./like_queries.ts";
import type { LikeEvent } from "./events.ts";
import type { LikeKind } from "./tables.ts";

/**
 * Likes a note for `accountId`, and counts it, unless it already likes it. Returns the note as it
 * is now, or `undefined` if there is none `accountId` may see.
 */
export const like = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const note = await visibleNote(tx, noteId, accountId);
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
 * Undoes `accountId`'s like of a note, and uncounts it. Returns the note as it is now, or
 * `undefined` if there is none. As on Mastodon, a note it liked can be unliked even if it may no
 * longer see it, and one it didn't only if it may. Local users never dislike notes, so there is no
 * dislike to undo.
 */
export const unlike = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const removed = await deleteLike(tx, accountId, noteId);
        if (removed === undefined) return await visibleNote(tx, noteId, accountId);

        await countLike(tx, noteId, -1);

        const event: LikeEvent = {
            type: "interactions.unliked",
            likeId: removed.id,
            accountId,
            noteId,
        };
        await emit(tx, event);

        return await findNote(tx, noteId);
    });

/** Another instance's like or dislike of a note, by one of its users. */
export type RemoteLike = {
    readonly accountId: string;
    readonly noteId: string;
    readonly kind: LikeKind;
    readonly instanceId: string;
    readonly remoteId: string;
    readonly createdAt: Date;
};

/**
 * Keeps another instance's like or dislike, in place of the account's other one of the note, if
 * it has one, as an account can't like and dislike a note at once. Only likes are counted. One
 * Verso has already is left as it is.
 */
export const keepRemoteLike = async (ctx: Context, like: RemoteLike): Promise<void> => {
    if (await findRemoteLike(ctx, like.instanceId, like.remoteId)) return;

    const replaced = await deleteLike(ctx, like.accountId, like.noteId);
    if (replaced?.kind === "like") await countLike(ctx, like.noteId, -1);

    await insertRemoteLike(ctx, {
        id: ctx.ids(),
        account_id: like.accountId,
        note_id: like.noteId,
        kind: like.kind,
        instance_id: like.instanceId,
        remote_id: like.remoteId,
        created_at: like.createdAt,
    });
    if (like.kind === "like") await countLike(ctx, like.noteId, 1);
};

/** Undoes another instance's like or dislike, which a Delete said is gone, if Verso has it. */
export const undoRemoteLike = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> => {
    const like = await findRemoteLike(ctx, instanceId, remoteId);
    const removed = like && await deleteLikeById(ctx, like.id);
    if (removed?.kind === "like") await countLike(ctx, removed.note_id, -1);
};

/** Uncounts the likes of an account about to be deleted, before they go with it. */
export const uncountLikesOf = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isAccountDeleting(event)) await uncountLikesBy(ctx, event.accountId);
};
