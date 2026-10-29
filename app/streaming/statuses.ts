/**
 * Telling every process which statuses appeared, changed or went, so its streaming sessions can
 * send them to the viewers who may see them. Each message only names a status, or for one deleted,
 * who could see it, so nothing private travels between processes.
 * @see https://docs.joinmastodon.org/methods/streaming/#events
 * @module
 */
import { z } from "zod";
import type { Visibility } from "../kernel/visibility.ts";
import { isInteractionReceived, isShareEvent } from "../interactions/events.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { type Channel, publish } from "../kernel/pubsub.ts";
import { isNoteDeleted, isNoteEdited, isNotePosted, isNoteReceived } from "../notes/events.ts";

const visibility: z.ZodType<Visibility> = z.enum(["public", "unlisted", "private", "direct"]);

const StatusMessage = z.discriminatedUnion("event", [
    // A status or boost appeared, or a status was edited, which Mastodon calls `status.update`.
    z.object({ event: z.enum(["update", "status.update"]), noteId: z.string() }),
    // A status or boost was deleted, which only those who could see it are told.
    z.object({
        event: z.literal("delete"),
        noteId: z.string(),
        accountId: z.string(),
        visibility,
        mentionIds: z.array(z.string()),
    }),
]);

export type StatusMessage = z.infer<typeof StatusMessage>;

/** Says a status appeared, changed or went, in Mastodon's streaming events. */
export const statusMessages: Channel<StatusMessage> = {
    name: "streaming.statuses",
    schema: StatusMessage,
};

/** What `event` means for streams, if anything. */
const messageOf = (event: DomainEvent): StatusMessage | undefined => {
    if (isNotePosted(event)) return { event: "update", noteId: event.noteId };
    if (isNoteEdited(event)) return { event: "status.update", noteId: event.noteId };
    if (isNoteReceived(event)) {
        return { event: event.edited ? "status.update" : "update", noteId: event.noteId };
    }

    if (isNoteDeleted(event)) {
        const { noteId, accountId, visibility, mentionIds } = event;
        return { event: "delete", noteId, accountId, visibility, mentionIds: [...mentionIds] };
    }

    // A boost is a status of its own.
    if (isShareEvent(event)) {
        return event.type === "interactions.shared" ? { event: "update", noteId: event.shareId } : {
            event: "delete",
            noteId: event.shareId,
            accountId: event.accountId,
            visibility: event.visibility,
            mentionIds: [],
        };
    }
    if (isInteractionReceived(event) && event.kind === "share") {
        return { event: "update", noteId: event.id };
    }
};

/** Sends what `event` means for streams once the transaction commits, if anything. */
export const streamStatuses = async (ctx: Context, event: DomainEvent): Promise<void> => {
    const message = messageOf(event);
    if (message) await publish(ctx, statusMessages, message);
};
