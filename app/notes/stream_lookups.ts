/**
 * Single statuses of timelines, looked up for streaming them as they appear. Those of the public
 * and hashtag timelines are rendered as anyone sees them, so that each is rendered once for every
 * viewer. Those of home timelines are rendered for all their viewers together, as each sees them,
 * and those of lists for each list's owner.
 * @module
 */
import type { Status } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow, tagsOf } from "./note_queries.ts";
import { renderStatuses, renderStatusesFor } from "./render.ts";
import type { ListRow } from "../lists/list_queries.ts";
import { findHashtagNote, findHomeNote, findListNote, findPublicNote } from "./timeline_queries.ts";
import { homeSourcesOf, listSourcesOf } from "./timeline_sources.ts";

/** A status of a public or hashtag timeline. */
export type PublicStatus = {
    /**
     * Who posted it. Neither timeline has boosts, so they are the only account whose blocks or
     * mutes could leave it out.
     */
    readonly accountId: string;
    readonly local: boolean;
    /**
     * Renders it as anyone sees it: with none of a viewer's likes, boosts or bookmarks, and with
     * the likes, boosts and reactions of everyone counted.
     */
    readonly render: () => Promise<Status>;
};

const publicStatusOf = (ctx: Context, note: NoteRow): PublicStatus => ({
    accountId: note.account_id,
    local: note.instance_id === null,
    render: async () => {
        const [status] = await renderStatuses(ctx, [note], null);
        // Only boosts can render as nothing, and neither timeline has any.
        if (status === undefined) throw new Error(`Note ${note.id} rendered as nothing`);
        return status;
    },
});

/** The status `noteId`, if it is on the public timeline. */
export const publicStatus = async (
    ctx: Context,
    noteId: string,
): Promise<PublicStatus | undefined> => {
    const note = await findPublicNote(ctx, noteId);
    return note && publicStatusOf(ctx, note);
};

/** The status `noteId`, if it could be on a hashtag's timeline. */
export const hashtagStatus = async (
    ctx: Context,
    noteId: string,
): Promise<PublicStatus | undefined> => {
    const note = await findHashtagNote(ctx, noteId);
    return note && publicStatusOf(ctx, note);
};

/** Who could have a status on their home timeline: its author, their followers, and more. */
export type HomeReach = {
    readonly authorId: string;
    /** If it is public, its hashtags, in lower case, whose followers could have it too. */
    readonly tags: readonly string[];
};

/** Who could have the status or boost `noteId` on their home timeline, if it exists. */
export const homeReachOf = async (
    ctx: Context,
    noteId: string,
): Promise<HomeReach | undefined> => {
    const note = await findNote(ctx, noteId);
    if (note === undefined) return;

    const tags = note.visibility === "public" ? (await tagsOf(ctx, [noteId])).get(noteId) : [];
    return { authorId: note.account_id, tags: tags ?? [] };
};

/** The status `noteId`, if it is on `viewerId`'s home timeline. */
export const homeNote = (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    findHomeNote(ctx, viewerId, homeSourcesOf(ctx, viewerId), noteId);

/**
 * The status `note` as each of `viewerIds` sees it, rendered for all of them together, by viewer.
 * A boost of a status a viewer may not see renders as nothing, so they are left out.
 */
export const statusesFor = async (
    ctx: Context,
    note: NoteRow,
    viewerIds: readonly string[],
): Promise<Map<string, Status>> => {
    const rendered = await renderStatusesFor(ctx, [note], viewerIds);

    return new Map(viewerIds.flatMap((viewerId) => {
        const [status] = rendered.get(viewerId) ?? [];
        return status === undefined ? [] : [[viewerId, status]];
    }));
};

/** Who posted or boosted `noteId`, whose lists could have it, if it exists. */
export const listReachOf = async (ctx: Context, noteId: string): Promise<string | undefined> =>
    (await findNote(ctx, noteId))?.account_id;

/** The status `noteId` as the owner of `list` sees it, if it is on the list. */
export const listStatus = async (
    ctx: Context,
    list: ListRow,
    noteId: string,
): Promise<Status | undefined> => {
    const note = await findListNote(ctx, list.account_id, listSourcesOf(ctx, list), noteId);

    return note && (await renderStatuses(ctx, [note], list.account_id))[0];
};
