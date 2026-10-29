/**
 * Single statuses of timelines, looked up for streaming them as they appear. Those of the public
 * and hashtag timelines are rendered as anyone sees them, as Mastodon streams them, so that each is
 * rendered once for every viewer. Those of home timelines are rendered for each viewer.
 * @module
 */
import type { Status } from "@versia/client-api";
import { followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { findHashtagNote, findHomeNote, findPublicNote } from "./timeline_queries.ts";

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
