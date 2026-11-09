/**
 * Removing any user's statuses, as whoever runs the instance does.
 * @module
 */
import { unshare } from "../interactions/shares.ts";
import type { Context } from "../kernel/context.ts";
import { attachedTo } from "../media/attachments.ts";
import { deleteUploads } from "../media/uploads.ts";
import { findNote } from "../notes/note_queries.ts";
import { removeNote } from "../notes/removal.ts";

/**
 * Deletes any status or boost, as its author would. Other instances are told only of local ones:
 * a remote one is its instance's, which may send it again. A local status's media is deleted at
 * once, rather than kept so the status can be redrafted. Returns whether it existed.
 */
export const removeStatus = async (ctx: Context, id: string): Promise<boolean> => {
    const note = await findNote(ctx, id);
    if (note === undefined) return false;

    // A local boost is undone, so other instances are sent the Delete of a Share, not a Note.
    if (note.reblog_of_id !== null && note.instance_id === null) {
        await unshare(ctx, note.account_id, note.reblog_of_id);
        return true;
    }

    const media = note.instance_id === null ? await attachedTo(ctx, note.id) : [];
    if (!await removeNote(ctx, note.id)) return false;

    await deleteUploads(ctx, note.account_id, media.map((row) => row.id));

    return true;
};
