/**
 * Finding statuses by the start of their words, among those Mastodon searches: public statuses by
 * authors who chose to be `indexable`, and those the viewer wrote, was mentioned in, liked or
 * boosted. Only signed-in users search statuses, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/search/#v2
 * @module
 */
import { followedSubquery } from "../graph/follows.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes, type NoteRow } from "../notes/note_queries.ts";
import { noteIdsMatching } from "./search_queries.ts";
import { searchWords } from "./words.ts";

/** A search for statuses. */
export type StatusSearch = {
    /** Words. */
    readonly query: string;
    /** Who is searching. */
    readonly viewerId: string;
    /** The author to find statuses of, if only one's. */
    readonly accountId: string | null;
    /** The id statuses must be newer than, if any. */
    readonly minId: string | null;
    /** The id statuses must be older than, if any. */
    readonly maxId: string | null;
    readonly limit: number;
    readonly offset: number;
};

/**
 * The statuses `search` finds, newest first: those whose words start with each of its words, that
 * the viewer may see, by authors they don't block or mute.
 */
export const searchStatuses = async (ctx: Context, search: StatusSearch): Promise<NoteRow[]> => {
    const { viewerId } = search;
    const ids = await noteIdsMatching(ctx, searchWords(search.query), {
        ...search,
        onlooker: { id: viewerId, followed: followedSubquery(ctx, viewerId) },
        hidden: hiddenFrom(ctx, viewerId),
    });

    const found = new Map((await findNotes(ctx, ids)).map((note) => [note.id, note]));
    return ids.flatMap((id) => found.get(id) ?? []);
};
