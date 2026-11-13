/**
 * Polls as Versia has them, in the `extensions` of the Notes they are on: local ones, which Verso
 * sends, and remote ones, which Verso receives.
 * @see https://versia.pub/extensions/polls
 * @module
 */
import { v0_6 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import {
    deletePoll,
    insertPoll,
    type NewPoll,
    type PollWithOptions,
    setRemoteVotes,
    updatePoll,
} from "./poll_queries.ts";
import { asksAnew, hasEnded } from "./polls.ts";

/**
 * How many options of a remote poll Verso stores. Each costs a query, so a poll can't make Verso do
 * unbounded work.
 */
const remoteOptions = 100;

/** A remote poll, with how many votes each option has. */
export type RemotePoll = NewPoll & { readonly votes: readonly number[] };

/**
 * The `extensions` that a local status with the poll `poll` has, or `undefined` if it has none.
 * Like Mastodon, a poll that hides its totals sends none until it ends, but Versia requires them,
 * so each option has 0.
 */
export const pollExtensions = (
    ctx: Context,
    poll: PollWithOptions | undefined,
): v0_6.Entity["extensions"] => {
    if (poll === undefined) return undefined;

    const hidden = poll.hide_totals && !hasEnded(ctx, poll);
    const extension: v0_6.Polls = {
        options: poll.options.map((option) => ({
            "text/plain": { content: option.title, remote: false },
        })),
        votes: poll.options.map((option) => hidden ? 0 : option.votes_count),
        multiple_choice: poll.multiple,
        expires_at: poll.expires_at?.toISOString(),
    };
    return { [v0_6.pollsKey]: extension };
};

/** An option's title, as text, from its plain text or else its HTML. */
const titleOf = (option: v0_6.ContentFormat) => {
    const text = (type: string) => {
        const format = option[type];
        return format === undefined || format.remote ? undefined : format.content;
    };

    const html = text("text/html");
    return (text("text/plain") ?? (html === undefined ? "" : textOfHtml(html))).trim();
};

/**
 * The poll a remote Note's `extensions` give, with its first options, as many as Verso stores, or
 * `undefined` if it has none. An option without a count has no votes. An extension that doesn't
 * match Versia's definition, or a poll with no options, is treated as no poll.
 */
export const remotePollOf = (extensions: v0_6.Entity["extensions"]): RemotePoll | undefined => {
    const parsed = v0_6.Polls.safeParse(extensions?.[v0_6.pollsKey]);
    if (!parsed.success || parsed.data.options.length === 0) return undefined;

    const options = parsed.data.options.slice(0, remoteOptions);
    return {
        options: options.map(titleOf),
        votes: options.map((_, index) => parsed.data.votes[index] ?? 0),
        multiple: parsed.data.multiple_choice,
        // Versia has no such setting.
        hideTotals: false,
        expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
    };
};

/** Whether a remote status with the poll `previous` is edited by now having `poll`. */
export const editsRemotePoll = (
    previous: PollWithOptions | undefined,
    poll: RemotePoll | undefined,
): boolean =>
    previous === undefined || poll === undefined ? previous !== poll : asksAnew(previous, poll);

/**
 * Gives the remote status `noteId`, whose poll was `previous`, the poll `poll`, or none if it is
 * `undefined`. A poll that asks something else loses the votes local users cast in it.
 */
export const keepRemotePoll = async (
    ctx: Context,
    noteId: string,
    previous: PollWithOptions | undefined,
    poll: RemotePoll | undefined,
): Promise<void> => {
    if (poll === undefined) {
        if (previous) await deletePoll(ctx, previous);
        return;
    }

    const id = previous?.id ?? await insertPoll(ctx, noteId, poll);
    if (previous) await updatePoll(ctx, previous, poll, asksAnew(previous, poll));
    await setRemoteVotes(ctx, id, poll.votes);
};
