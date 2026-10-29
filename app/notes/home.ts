/**
 * Single statuses of a user's home timeline, for streaming them as they appear.
 * @module
 */
import type { Status } from "@versia/client-api";
import { followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { findNote } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { findHomeNote } from "./timeline_queries.ts";

/**
 * Who posted the status or boost `noteId`, if it exists. It can be on the home timelines of them
 * and their followers only.
 */
export const homeAuthorOf = async (ctx: Context, noteId: string): Promise<string | undefined> =>
    (await findNote(ctx, noteId))?.account_id;

/** The status `noteId` as `viewerId` sees it, if it is on their home timeline. */
export const homeStatus = async (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<Status | undefined> => {
    const note = await findHomeNote(
        ctx,
        viewerId,
        followedSubquery(ctx, viewerId),
        sharingSubquery(ctx, viewerId),
        hiddenFrom(ctx, viewerId),
        noteId,
    );

    return note && (await renderStatuses(ctx, [note], viewerId))[0];
};
