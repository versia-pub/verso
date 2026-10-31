/**
 * Direct conversations: for each local user, the direct statuses they posted or were mentioned in,
 * grouped by thread and by who else is in them, as Mastodon has them. A user is added to one as
 * they would be notified of the status, and the user who posts a status has read it.
 * @see https://docs.joinmastodon.org/methods/conversations/
 * @module
 */
import { findAccounts } from "../accounts/account_queries.ts";
import { hidingAmong } from "../graph/hidden.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { isNoteDeleted, isNotePosted, isNoteReceived } from "../notes/events.ts";
import { findNote, mentionsOf } from "../notes/note_queries.ts";
import { threadMutersAmong } from "../notes/thread_mute_queries.ts";
import { addToConversation, refreshConversations } from "./conversation_queries.ts";

/**
 * Adds the direct status `noteId` to the conversations of its local author and the local users it
 * mentions, but not of those who hide its author or mute its thread, whom it doesn't notify.
 */
const addNote = async (ctx: Context, noteId: string) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined || note.visibility !== "direct") return;

    const mentionIds = (await mentionsOf(ctx, [noteId])).get(noteId) ?? [];
    const everyone = [...new Set([note.account_id, ...mentionIds])];
    const locals = (await findAccounts(ctx, everyone))
        .filter((account) => account.domain === null)
        .map((account) => account.id);

    const mentioned = locals.filter((id) => id !== note.account_id);
    const hiding = await hidingAmong(ctx, note.account_id, mentioned);
    const muting = await threadMutersAmong(ctx, note.thread_id, mentioned);
    const recipients = locals.filter((id) =>
        id === note.account_id || (!hiding.has(id) && !muting.has(id))
    );

    for (const accountId of recipients) {
        const participants = everyone.filter((id) => id !== accountId).toSorted().join(" ");
        await addToConversation(
            ctx,
            { accountId, threadId: note.thread_id, participants },
            note.id,
            note.account_id !== accountId,
        );
    }
};

/**
 * Keeps conversations as statuses are posted, received and deleted. Edits change none, and remote
 * statuses Verso fetched are added to none, as they notify no one.
 */
export const trackConversations = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event)) return await addNote(ctx, event.noteId);
    if (isNoteReceived(event) && !event.edited && !event.fetched) {
        return await addNote(ctx, event.noteId);
    }

    if (isNoteDeleted(event) && event.visibility === "direct") {
        await refreshConversations(ctx, [event.accountId, ...event.mentionIds]);
    }
};
