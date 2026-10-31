/**
 * Single statuses of timelines, looked up for streaming them as they appear. Those of the public
 * and hashtag timelines are rendered as anyone sees them, as Mastodon streams them, so that each is
 * rendered once for every viewer. Those of home timelines are rendered for each viewer.
 * @module
 */
import type { Status } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow, tagsOf } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { findHashtagNote, findHomeNote, findPublicNote } from "./timeline_queries.ts";
import { homeSourcesOf } from "./timeline_sources.ts";

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

/** The status `noteId` as `viewerId` sees it, if it is on their home timeline. */
export const homeStatus = async (
    ctx: Context,
    viewerId: string,
    noteId: string,
): Promise<Status | undefined> => {
    const note = await findHomeNote(ctx, viewerId, homeSourcesOf(ctx, viewerId), noteId);

    return note && (await renderStatuses(ctx, [note], viewerId))[0];
};
