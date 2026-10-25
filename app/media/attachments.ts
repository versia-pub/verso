/**
 * Files attached to notes. Each is an upload its author made, attached to one note at most, once it
 * is processed.
 * @module
 */
import { Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { insertAttachments, unattachedUploads } from "./attachment_queries.ts";

/**
 * Attaches the uploads `mediaIds`, in that order, to the note `noteId` by `accountId`, as Mastodon
 * does: each must be one they uploaded, not attached to another note, and processed. Given twice,
 * one is attached once. Run it in the transaction that makes the note, which it ends otherwise.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
export const attach = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    mediaIds: readonly string[],
): Promise<void> => {
    const ids = [...new Set(mediaIds)];

    const uploads = new Map(
        (await unattachedUploads(ctx, accountId, ids)).map((row) => [row.id, row]),
    );
    const missing = ids.filter((id) => !uploads.has(id));
    if (missing.length > 0) throw new Unprocessable(`Media not found: ${missing.join(", ")}`);

    const processing = ids.filter((id) => uploads.get(id)?.processed_at === null);
    if (processing.length > 0) {
        throw new Unprocessable(`Media still being processed: ${processing.join(", ")}`);
    }

    await insertAttachments(ctx, noteId, ids);
};
