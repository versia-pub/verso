/**
 * Quoting statuses: which ones a user may quote, and how a quote appears to someone viewing it.
 * Verso has no quote approval or policies, so a status that may be quoted at all may be quoted by
 * anyone who can see it. A user who blocks someone can't quote them. Whether someone blocks the
 * quoter isn't looked at, since Verso never lets a blocked account tell.
 * @see https://docs.joinmastodon.org/entities/Quote/
 * @module
 */
import type { QuoteApproval, ShallowQuote } from "@versia/client-api";
import { blocksBetween } from "../graph/block_queries.ts";
import { domainBlockedAmong } from "../graph/domain_block_queries.ts";
import { mutesOf } from "../graph/mute_queries.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes, type NoteRow } from "./note_queries.ts";
import { notesSeenBy } from "./thread_queries.ts";
import { onlookerOf, visibleOriginal } from "./visibility.ts";

/**
 * Whether anyone may quote `note`: a direct status can't be quoted, and a private one only by its
 * author, since its followers' quotes could reach others than its audience.
 */
const quotableBy = (note: Pick<NoteRow, "visibility" | "account_id">, viewerId: string): boolean =>
    note.visibility === "public" || note.visibility === "unlisted" ||
    (note.visibility === "private" && note.account_id === viewerId);

/**
 * The status `quoterId` quotes by naming `id`, or `undefined` if they may not. A boost stands for
 * the status it boosts. `quoterId` has to be able to see the status, and not block its author,
 * individually or by their domain.
 */
export const quotableNote = async (
    ctx: Context,
    quoterId: string,
    id: string,
): Promise<NoteRow | undefined> => {
    const note = await visibleOriginal(ctx, id, quoterId);
    if (note === undefined || !quotableBy(note, quoterId)) return undefined;

    const { blocking } = await blocksBetween(ctx, quoterId, [note.account_id]);
    if (blocking.size > 0) return undefined;
    if ((await domainBlockedAmong(ctx, quoterId, [note.account_id])).size > 0) return undefined;

    return note;
};

/**
 * Who may quote `note`, and whether `viewerId` may. Anyone may quote the public and unlisted
 * statuses, without review, and nobody else may quote the others, but their author.
 */
export const quoteApproval = (
    note: Pick<NoteRow, "visibility" | "account_id">,
    viewerId: string | null,
): QuoteApproval => ({
    automatic: note.visibility === "public" || note.visibility === "unlisted" ? ["public"] : [],
    manual: [],
    current_user: viewerId !== null && quotableBy(note, viewerId) ? "automatic" : "denied",
});

/** A quote of a status, as seen by its viewer. */
export type QuoteView = {
    readonly state: ShallowQuote["state"];
    /** The quoted status, if the viewer may be shown it. */
    readonly note: NoteRow | null;
};

/**
 * How each of `quotes`, which maps a status to the status it quotes, appears to `viewerId`, or to
 * anyone if it is `null`, by the id of the quoting status. A quote of a status the viewer may not
 * see is `unauthorized`. Those that the viewer blocks, by domain or individually, and mutes still
 * show, with their state, except to the quoted author.
 */
export const quoteViews = async (
    ctx: Context,
    quotes: ReadonlyMap<string, string>,
    viewerId: string | null,
): Promise<Map<string, QuoteView>> => {
    const ids = [...new Set(quotes.values())];
    const notes = new Map((await findNotes(ctx, ids)).map((note) => [note.id, note]));
    const seen = await notesSeenBy(ctx, ids, onlookerOf(ctx, viewerId));

    const authorIds = [...new Set([...notes.values()].map((note) => note.account_id))];
    const hiding = viewerId === null ? null : {
        blocking: (await blocksBetween(ctx, viewerId, authorIds)).blocking,
        domains: await domainBlockedAmong(ctx, viewerId, authorIds),
        muting: await mutesOf(ctx, viewerId, authorIds),
    };

    const views = new Map<string, QuoteView>();
    for (const [id, quotedId] of quotes) {
        const note = notes.get(quotedId);
        if (note === undefined) continue;

        if (!seen.has(quotedId)) {
            views.set(id, { state: "unauthorized", note: null });
            continue;
        }

        const author = note.account_id;
        const state = viewerId === author || hiding === null
            ? "accepted"
            : hiding.domains.has(author)
            ? "blocked_domain"
            : hiding.blocking.has(author)
            ? "blocked_account"
            : hiding.muting.has(author)
            ? "muted_account"
            : "accepted";
        views.set(id, { state, note });
    }

    return views;
};
