/**
 * Direct conversations: for each local user, the direct statuses they posted or were mentioned in,
 * grouped by thread and by who else is in them, as Mastodon has them. A user is added to one as
 * they would be notified of the status, and the user who posts a status has read it. Each change to
 * one that is still there is published, so that the user's apps are told on their `direct` streams.
 * @see https://docs.joinmastodon.org/methods/conversations/
 * @module
 */
import { z } from "zod";
import { findAccounts } from "../accounts/account_queries.ts";
import { hidingAmong } from "../graph/hidden.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import { isNoteDeleted, isNotePosted, isNoteReceived } from "../notes/events.ts";
import { findNote, mentionsOf } from "../notes/note_queries.ts";
import { mentionedAmong } from "../notifications/notification_queries.ts";
import {
    addToConversation,
    type ConversationRow,
    markConversation,
    refreshConversations,
} from "./conversation_queries.ts";

/** Whose conversation changed, and which. */
export type ConversationChangedMessage = {
    readonly accountId: string;
    readonly conversationId: string;
};

/**
 * Says a user's conversation has a new status, lost its latest, or was marked read or unread, so
 * every process can stream it.
 */
export const conversationChanged: Channel<ConversationChangedMessage> = {
    name: "conversations.changed",
    schema: z.object({ accountId: z.string(), conversationId: z.string() }),
};

const changed = (ctx: Context, row: ConversationRow) =>
    publish(ctx, conversationChanged, { accountId: row.account_id, conversationId: row.id });

/**
 * Adds the direct status `noteId` to the conversations of its local author and the local users it
 * mentions, as on Mastodon: those it notified, unless their policies filtered the mention, and who
 * don't hide its author.
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
    const notified = await mentionedAmong(ctx, note.id, mentioned);
    const recipients = locals.filter((id) =>
        id === note.account_id || (!hiding.has(id) && notified.has(id))
    );

    for (const accountId of recipients) {
        const participants = everyone.filter((id) => id !== accountId).toSorted().join(" ");
        const row = await addToConversation(
            ctx,
            { accountId, threadId: note.thread_id, participants },
            note.id,
            note.account_id !== accountId,
        );
        await changed(ctx, row);
    }
};

/** Marks `accountId`'s conversation `id` read or unread, and returns it, if they have it. */
export const markConversationAs = async (
    ctx: Context,
    accountId: string,
    id: string,
    unread: boolean,
): Promise<ConversationRow | undefined> => {
    const row = await markConversation(ctx, accountId, id, unread);
    if (row !== undefined) await changed(ctx, row);

    return row;
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
        const refreshed = await refreshConversations(ctx, [event.accountId, ...event.mentionIds]);
        for (const row of refreshed) await changed(ctx, row);
    }
};
