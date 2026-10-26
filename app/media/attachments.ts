/**
 * Media attached to statuses. Each attachment is an upload by the status's author, attached to at
 * most one status, and only once it is processed (unless processing failed).
 * @module
 */
import { Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import type { VersionMedia } from "../notes/tables.ts";
import {
    attachmentsOf,
    deleteAttachments,
    insertAttachments,
    unattachedUploads,
} from "./attachment_queries.ts";
import { type MediaRow, type RemoteMedia, saveRemoteMedia } from "./media_queries.ts";
import { describeUpload, processingFailed, type UploadDescription } from "./uploads.ts";

/**
 * Attaches the uploads `mediaIds`, in that order, to the status `noteId` by `accountId`, as
 * Mastodon does. Each must be an upload by that account, not attached to another status, and
 * processed. An id given twice is attached once. Run it in the transaction that creates the status;
 * it ends the transaction otherwise.
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

    const failed = ids.filter((id) => {
        const upload = uploads.get(id);
        return upload !== undefined && processingFailed(upload);
    });
    if (failed.length > 0) throw new Unprocessable(`Media failed to process: ${failed.join(", ")}`);

    await insertAttachments(ctx, noteId, ids);
};

/** A change to how a media attachment is described, by media id. */
export type AttachmentChange = UploadDescription & { readonly id: string };

/** The media attached to the status `noteId`, in order. */
export const attachedTo = async (ctx: Context, noteId: string): Promise<MediaRow[]> =>
    (await attachmentsOf(ctx, [noteId])).get(noteId) ?? [];

/** Media attached to a status, in the form its edit history stores. */
export const asVersionMedia = (rows: readonly MediaRow[]): VersionMedia[] =>
    rows.map((row) => ({ id: row.id, description: row.description }));

/** Whether `change` would change the description of `row`. */
const describesAnew = (row: MediaRow, change: AttachmentChange) =>
    (change.description !== undefined && (change.description || null) !== row.description) ||
    (change.focus !== undefined &&
        (change.focus.x !== row.focus_x || change.focus.y !== row.focus_y));

/**
 * Whether attaching `mediaIds` in place of the media `current` (or keeping `current` if `mediaIds`
 * is `undefined`), then applying the description `changes`, changes anything.
 */
export const changesAttachments = (
    current: readonly MediaRow[],
    mediaIds: readonly string[] | undefined,
    changes: readonly AttachmentChange[],
): boolean => {
    const ids = mediaIds === undefined ? current.map((row) => row.id) : [...new Set(mediaIds)];
    if (ids.join(",") !== current.map((row) => row.id).join(",")) return true;

    const rows = new Map(current.map((row) => [row.id, row]));
    return changes.some((change) => {
        const row = rows.get(change.id);
        return row !== undefined && describesAnew(row, change);
    });
};

/**
 * Replaces the media attached to the status `noteId` by `accountId` with `mediaIds`, as {@link
 * attach} does. If `mediaIds` is `undefined`, the media is kept. Then applies the description
 * `changes` to the attached media, as Mastodon does. Media that is no longer attached can be
 * attached again, or is removed along with other unattached uploads. Run it in the transaction that
 * edits the status.
 * @see https://docs.joinmastodon.org/methods/statuses/#edit
 */
export const reattach = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    mediaIds: readonly string[] | undefined,
    changes: readonly AttachmentChange[],
): Promise<void> => {
    if (mediaIds !== undefined) {
        await deleteAttachments(ctx, noteId);
        await attach(ctx, accountId, noteId, mediaIds);
    }

    const attached = new Set((await attachedTo(ctx, noteId)).map((row) => row.id));
    for (const change of changes) {
        if (attached.has(change.id)) await describeUpload(ctx, accountId, change.id, change);
    }
};

/**
 * Attaches the media of a remote status `noteId`, storing it as Verso stores remote media. Only the
 * first N are attached, where N is the maximum a local status may have, and descriptions are
 * truncated to the maximum length of a local description, so a remote status can't make Verso store
 * unbounded data. Run it in the transaction that stores the status.
 */
export const attachRemote = async (
    ctx: Context,
    instanceId: string,
    noteId: string,
    files: readonly RemoteMedia[],
): Promise<void> => {
    const ids = [];
    for (const file of files.slice(0, ctx.settings.attachments)) {
        const description = file.description &&
            Array.from(file.description).slice(0, ctx.settings.mediaDescription).join("");
        ids.push(await saveRemoteMedia(ctx, instanceId, null, { ...file, description }));
    }

    await insertAttachments(ctx, noteId, ids);
};
