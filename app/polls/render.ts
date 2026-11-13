import type { Poll } from "@versia/client-api";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import type { Context } from "../kernel/context.ts";
import { pollsOf, votesAmong } from "./poll_queries.ts";
import { hasEnded } from "./polls.ts";

/**
 * The polls of those of `notes` that have one, as each of `viewerIds` sees them, or as anyone does
 * for `null`, by viewer, then by status. A poll that hides its totals shows only how many voted
 * until it ends, even to its author.
 */
export const renderPollsFor = async (
    ctx: Context,
    notes: readonly { readonly id: string; readonly account_id: string }[],
    viewerIds: readonly (string | null)[],
): Promise<Map<string | null, Map<string, Poll>>> => {
    const polls = await pollsOf(ctx, notes.map((note) => note.id));
    if (polls.size === 0) return new Map(viewerIds.map((viewerId) => [viewerId, new Map()]));

    const pollIds = [...polls.values()].map((poll) => poll.id);
    const signedIn = viewerIds.filter((viewerId) => viewerId !== null);
    const votes = await votesAmong(ctx, signedIn, pollIds);
    const emojis = await emojisOfNotes(ctx, [...polls.keys()]);

    const shown = notes.flatMap((note) => {
        const poll = polls.get(note.id);
        if (poll === undefined) return [];

        const ended = hasEnded(ctx, poll);
        const titles = poll.options.map((option) => option.title).join(" ");
        return [{
            note,
            pollId: poll.id,
            rendered: {
                id: poll.id,
                expires_at: poll.expires_at?.toISOString() ?? null,
                expired: ended,
                multiple: poll.multiple,
                votes_count: poll.options.reduce((sum, option) => sum + option.votes_count, 0),
                voters_count: poll.voters_count,
                options: poll.options.map((option) => ({
                    title: option.title,
                    votes_count: poll.hide_totals && !ended ? null : option.votes_count,
                })),
                // The status's custom emojis that the options use.
                emojis: renderEmojis(
                    ctx,
                    (emojis.get(note.id) ?? []).filter((emoji) =>
                        titles.includes(`:${emoji.shortcode}:`)
                    ),
                ),
            },
        }];
    });

    return new Map(viewerIds.map((viewerId) => [
        viewerId,
        new Map(shown.map(({ note, pollId, rendered }): [string, Poll] => {
            if (viewerId === null) return [note.id, rendered];

            const own = votes.get(viewerId)?.get(pollId) ?? [];
            return [note.id, {
                ...rendered,
                voted: note.account_id === viewerId || own.length > 0,
                own_votes: own,
            }];
        })),
    ]));
};

/**
 * The polls of those of `notes` that have one, by status, as {@link renderPollsFor} renders them.
 */
export const renderPolls = async (
    ctx: Context,
    notes: readonly { readonly id: string; readonly account_id: string }[],
    viewerId: string | null,
): Promise<Map<string, Poll>> =>
    (await renderPollsFor(ctx, notes, [viewerId])).get(viewerId) ?? new Map();
