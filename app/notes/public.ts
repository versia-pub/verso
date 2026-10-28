/**
 * Single statuses of the public and hashtag timelines, for streaming them as they appear.
 * @module
 */
import type { Status } from "@versia/client-api";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { renderStatuses } from "./render.ts";
import type { NoteRow } from "./note_queries.ts";
import { findHashtagNote, findPublicNote } from "./timeline_queries.ts";

/** A status of a public or hashtag timeline as a viewer sees it, and whether it is local. */
export type PublicStatus = { readonly status: Status; readonly local: boolean };

/** `note` as `viewerId` sees it. */
const shownTo = async (ctx: Context, viewerId: string, note: NoteRow) => {
    const [status] = await renderStatuses(ctx, [note], viewerId);
    return status && { status, local: note.instance_id === null };
};

/** The status `noteId` as `viewerId` sees it, if it is on the public timeline they see. */
export const publicStatus = async (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<PublicStatus | undefined> => {
    const note = await findPublicNote(ctx, hiddenFrom(ctx, viewerId), noteId);
    return note && await shownTo(ctx, viewerId, note);
};

/** The status `noteId` as `viewerId` sees it, if it could be on a hashtag's timeline they see. */
export const hashtagStatus = async (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<PublicStatus | undefined> => {
    const note = await findHashtagNote(ctx, hiddenFrom(ctx, viewerId), noteId);
    return note && await shownTo(ctx, viewerId, note);
};
