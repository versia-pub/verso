/**
 * Reactions to statuses, each with an emoji: a Unicode one, or a custom one, which local users take
 * from the local instance's emojis. A user reacts to a status with each emoji once, and with as
 * many emojis as they like, as on Versia Server.
 * @see https://versia.pub/extensions/reactions
 * @module
 */
import { localEmojiIds } from "../emojis/emoji_queries.ts";
import { keepRemoteEmojis, type RemoteEmoji } from "../emojis/emojis.ts";
import { isEmojiDeleted } from "../emojis/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { visibleNote, visibleOriginal } from "../notes/visibility.ts";
import type { ReactionEvent } from "./events.ts";
import {
    deleteReaction,
    deleteReactionById,
    deleteReactionsWith,
    findRemoteReaction,
    insertReaction,
    insertRemoteReaction,
    type ReactionEmoji,
} from "./reaction_queries.ts";

/** Whether `text` is one Unicode emoji, as Unicode recommends them, with any skin tone. */
export const isUnicodeEmoji = (text: string): boolean => /^\p{RGI_Emoji}$/v.test(text);

/**
 * The emoji a local user names to react with: a Unicode emoji, or one of the local instance's
 * custom emojis by its shortcode in colons, such as `:blobcat:`, or `undefined` if it is neither.
 */
export const reactionEmoji = async (
    ctx: Context,
    name: string,
): Promise<ReactionEmoji | undefined> => {
    const shortcode = /^:([A-Za-z0-9_-]+):$/u.exec(name)?.[1];
    if (shortcode !== undefined) {
        const [id] = await localEmojiIds(ctx, [shortcode]);
        return id === undefined ? undefined : { text: null, emoji_id: id };
    }

    return isUnicodeEmoji(name) ? { text: name, emoji_id: null } : undefined;
};

/** The result of reacting to a status, or undoing it: the status, or why there is none. */
export type ReactionResult =
    | NoteRow
    /** There is no such status, or the account may not see it. */
    | "missing"
    /** The emoji is neither Unicode nor the local instance's. */
    | "unknown emoji";

/**
 * Reacts to a status for `accountId`, a local user, or to the status a boost boosts, with the emoji
 * `name`, unless it already has. Returns the status as it is now.
 */
export const react = (
    ctx: Context,
    accountId: string,
    noteId: string,
    name: string,
): Promise<ReactionResult> =>
    ctx.transaction(async (tx) => {
        const note = await visibleOriginal(tx, noteId, accountId);
        if (note === undefined) return "missing";

        const emoji = await reactionEmoji(tx, name);
        if (emoji === undefined) return "unknown emoji";

        const added = await insertReaction(tx, accountId, note.id, emoji);
        if (added) {
            const event: ReactionEvent = {
                type: "interactions.reacted",
                reactionId: added.id,
                accountId,
                noteId: note.id,
            };
            await emit(tx, event);
        }

        return note;
    });

/**
 * Undoes `accountId`'s reaction to a status, or to the status a boost boosts, with the emoji
 * `name`. Returns the status as it is now. As with likes, a status that was reacted to can be
 * undone even if the account may no longer see it, and one that wasn't only if it may.
 */
export const unreact = (
    ctx: Context,
    accountId: string,
    noteId: string,
    name: string,
): Promise<ReactionResult> =>
    ctx.transaction(async (tx) => {
        const reacted = (await findNote(tx, noteId))?.reblog_of_id ?? noteId;

        const emoji = await reactionEmoji(tx, name);
        const removed = emoji && await deleteReaction(tx, accountId, reacted, emoji);
        if (removed === undefined) {
            const note = await visibleNote(tx, reacted, accountId);
            if (note === undefined) return "missing";
            return emoji === undefined ? "unknown emoji" : note;
        }

        const event: ReactionEvent = {
            type: "interactions.unreacted",
            reactionId: removed.id,
            accountId,
            noteId: reacted,
        };
        await emit(tx, event);

        return await findNote(tx, reacted) ?? "missing";
    });

/**
 * Undoes local users' reactions with a local emoji that is being deleted, as if they had undone
 * them, so remote instances are sent Deletes.
 */
export const undoReactionsWithDeletedEmoji = async (
    ctx: Context,
    event: DomainEvent,
): Promise<void> => {
    if (!isEmojiDeleted(event)) return;

    for (const reaction of await deleteReactionsWith(ctx, event.emojiId)) {
        const undone: ReactionEvent = {
            type: "interactions.unreacted",
            reactionId: reaction.id,
            accountId: reaction.account_id,
            noteId: reaction.note_id,
        };
        await emit(ctx, undone);
    }
};

/** A remote reaction, as Verso stores it. */
export type RemoteReaction = {
    readonly accountId: string;
    readonly noteId: string;
    /** A Unicode emoji, or one of the remote instance's custom emojis. */
    readonly emoji: string | RemoteEmoji;
    readonly instanceId: string;
    readonly remoteId: string;
    readonly createdAt: Date;
};

/**
 * Stores a remote reaction, with its custom emoji, unless Verso has it, or the account already
 * reacts to the status with that emoji.
 */
export const keepRemoteReaction = async (ctx: Context, reaction: RemoteReaction): Promise<void> => {
    const { emoji } = reaction;
    const [emojiId] = typeof emoji === "string"
        ? []
        : await keepRemoteEmojis(ctx, reaction.instanceId, [emoji]);

    await insertRemoteReaction(ctx, {
        id: ctx.ids(),
        account_id: reaction.accountId,
        note_id: reaction.noteId,
        text: typeof emoji === "string" ? emoji : null,
        emoji_id: emojiId ?? null,
        instance_id: reaction.instanceId,
        remote_id: reaction.remoteId,
        created_at: reaction.createdAt,
    });
};

/** Undoes a remote reaction, which a Delete said is gone, if Verso has it. */
export const undoRemoteReaction = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> => {
    const reaction = await findRemoteReaction(ctx, instanceId, remoteId);
    if (reaction) await deleteReactionById(ctx, reaction.id);
};
