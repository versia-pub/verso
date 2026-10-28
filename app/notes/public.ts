/**
 * Single statuses of the public timeline, for streaming them as they appear.
 * @module
 */
import type { Status } from "@versia/client-api";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { renderStatuses } from "./render.ts";
import { findPublicNote } from "./timeline_queries.ts";

/** A status of the public timeline as a viewer sees it, and whether it is local. */
export type PublicStatus = { readonly status: Status; readonly local: boolean };

/** The status `noteId` as `viewerId` sees it, if it is on the public timeline they see. */
export const publicStatus = async (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<PublicStatus | undefined> => {
    const note = await findPublicNote(ctx, hiddenFrom(ctx, viewerId), noteId);
    if (!note) return;

    const [status] = await renderStatuses(ctx, [note], viewerId);
    return status && { status, local: note.instance_id === null };
};
