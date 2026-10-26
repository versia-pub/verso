/**
 * Files attached to notes. Each is an upload its author made, attached to one note at most, once it
 * is processed, unless processing it failed.
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

    const failed = ids.filter((id) => {
        const upload = uploads.get(id);
        return upload !== undefined && processingFailed(upload);
    });
    if (failed.length > 0) throw new Unprocessable(`Media failed to process: ${failed.join(", ")}`);

    await insertAttachments(ctx, noteId, ids);
};

/** A change to how a file attached to a note is described, by the file's id. */
export type AttachmentChange = UploadDescription & { readonly id: string };

/** The files attached to the note `noteId`, in order. */
export const attachedTo = async (ctx: Context, noteId: string): Promise<MediaRow[]> =>
    (await attachmentsOf(ctx, [noteId])).get(noteId) ?? [];

/** Files attached to a note, as its history keeps them. */
export const asVersionMedia = (rows: readonly MediaRow[]): VersionMedia[] =>
    rows.map((row) => ({ id: row.id, description: row.description }));

/** Whether `change` would describe `row` differently. */
const describesAnew = (row: MediaRow, change: AttachmentChange) =>
    (change.description !== undefined && (change.description || null) !== row.description) ||
    (change.focus !== undefined &&
        (change.focus.x !== row.focus_x || change.focus.y !== row.focus_y));

/**
 * Whether attaching `mediaIds` in place of the files `current`, or keeping them if it is
 * `undefined`, then describing them as `changes` say, changes anything.
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
 * Attaches `mediaIds` to the note `noteId` by `accountId` in place of its files, as {@link attach}
 * does, unless it is `undefined`, then describes the files attached as `changes` say, as Mastodon
 * does. Files no longer attached can be attached again, or are removed with other uploads that
 * aren't. Run it in the transaction that edits the note.
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
 * Attaches the files another instance attached to its note `noteId`, as Verso keeps them: the
 * first as many as a local status may have, with their descriptions cut to the length a local
 * one's may be, so that a note can't make Verso keep without bound. Run it in the transaction that
 * keeps the note.
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
