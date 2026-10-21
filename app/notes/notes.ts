/**
 * Notes, on this instance or another: who may see them, and deleting them.
 * @module
 */
import { countNote } from "../accounts/accounts.ts";
import { isFollowing } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { NoteDeleted } from "./events.ts";
import {
    countReply,
    deleteNote,
    findNote,
    mentions,
    mentionsOf,
    type NoteRow,
} from "./note_queries.ts";

/**
 * Whether `viewerId`, or anyone if it is `null`, may see `note`. Public and unlisted notes are for
 * anyone, private ones for the author's followers, and direct ones for those they mention, who
 * may always see a note, as may its author.
 */
export const canSee = async (
    ctx: Context,
    note: NoteRow,
    viewerId: string | null,
): Promise<boolean> => {
    if (note.visibility === "public" || note.visibility === "unlisted") return true;
    if (viewerId === null) return false;
    if (viewerId === note.account_id || await mentions(ctx, note.id, viewerId)) return true;

    return note.visibility === "private" && await isFollowing(ctx, viewerId, note.account_id);
};

/** The note with this id, if there is one and `viewerId` may see it. */
export const visibleNote = async (
    ctx: Context,
    id: string,
    viewerId: string | null,
): Promise<NoteRow | undefined> => {
    const note = await findNote(ctx, id);
    return note && await canSee(ctx, note, viewerId) ? note : undefined;
};

/** Deletes a note, uncounting it. Returns whether there was one. */
export const removeNote = (ctx: Context, id: string): Promise<boolean> =>
    ctx.transaction(async (tx) => {
        // Read while they are there: the event says who could see the note, so they can be told.
        const mentionIds = (await mentionsOf(tx, [id])).get(id) ?? [];
        const note = await deleteNote(tx, id);
        if (note === undefined) return false;

        await countNote(tx, note.account_id, -1, note.created_at);
        if (note.in_reply_to_id !== null) await countReply(tx, note.in_reply_to_id, -1);

        const event: NoteDeleted = {
            type: "notes.deleted",
            noteId: note.id,
            accountId: note.account_id,
            visibility: note.visibility,
            mentionIds,
        };
        await emit(tx, event);

        return true;
    });
