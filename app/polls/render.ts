import type { Poll } from "@versia/client-api";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import type { Context } from "../kernel/context.ts";
import { pollsOf, votesAmong } from "./poll_queries.ts";
import { hasEnded } from "./polls.ts";

/**
 * The polls of those of `notes` that have one, by status, as `viewerId` sees them, or as anyone does
 * if it is `null`. A poll that hides its totals shows only how many voted until it ends, as on
 * Mastodon, even to its author.
 */
export const renderPolls = async (
    ctx: Context,
    notes: readonly { readonly id: string; readonly account_id: string }[],
    viewerId: string | null,
): Promise<Map<string, Poll>> => {
    const polls = await pollsOf(ctx, notes.map((note) => note.id));
    if (polls.size === 0) return new Map();

    const pollIds = [...polls.values()].map((poll) => poll.id);
    const votes = viewerId === null ? new Map() : await votesAmong(ctx, viewerId, pollIds);
    const emojis = await emojisOfNotes(ctx, [...polls.keys()]);

    return new Map(notes.flatMap((note): [string, Poll][] => {
        const poll = polls.get(note.id);
        if (poll === undefined) return [];

        const ended = hasEnded(ctx, poll);
        const titles = poll.options.map((option) => option.title).join(" ");
        const own: number[] = votes.get(poll.id) ?? [];

        return [[note.id, {
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
            ...viewerId === null
                ? {}
                : { voted: note.account_id === viewerId || own.length > 0, own_votes: own },
        }]];
    }));
};
