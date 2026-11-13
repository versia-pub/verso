import type { Status } from "@versia/client-api";
import type { Cursors } from "../http/responses.ts";
import { cursorsOf, type PageQuery } from "../http/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { NoteRow } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";

/** The response to a request for a page of statuses: `notes` as `viewerId` sees them, and cursors. */
export const statusPage = async (
    ctx: Context,
    notes: readonly NoteRow[],
    query: PageQuery,
    viewerId: string | null,
): Promise<{ status: 200; body: Status[]; cursors: Cursors }> => ({
    status: 200,
    body: await renderStatuses(ctx, notes, viewerId),
    cursors: cursorsOf(notes, query, (note) => note.id),
});
