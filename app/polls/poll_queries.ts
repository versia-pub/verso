import { type Selectable, sql } from "kysely";
import { skippingLocked } from "../db/locking.ts";
import type { Context } from "../kernel/context.ts";
import type { PollOptionsTable, PollsTable, PollVotesTable } from "./tables.ts";

export type PollRow = Selectable<PollsTable>;
export type PollOptionRow = Selectable<PollOptionsTable>;
export type PollVoteRow = Selectable<PollVotesTable>;

/** A poll with its options, in order. */
export type PollWithOptions = PollRow & { readonly options: readonly PollOptionRow[] };

/** A poll as its author asks it. */
export type NewPoll = {
    /** Its options' titles, in order. */
    readonly options: readonly string[];
    readonly multiple: boolean;
    readonly hideTotals: boolean;
    readonly expiresAt: Date | null;
};

const insertOptions = async (ctx: Context, pollId: string, titles: readonly string[]) => {
    await ctx.db.insertInto("poll_options")
        .values(titles.map((title, position) => ({ poll_id: pollId, position, title })))
        .execute();
};

/** Adds a poll with no votes to the status `noteId`, and returns its id. */
export const insertPoll = async (ctx: Context, noteId: string, poll: NewPoll): Promise<string> => {
    const id = ctx.ids();

    await ctx.db.insertInto("polls")
        .values({
            id,
            note_id: noteId,
            multiple: poll.multiple,
            hide_totals: poll.hideTotals,
            expires_at: poll.expiresAt,
            voters_count: 0,
            created_at: ctx.clock.now(),
        })
        .execute();
    await insertOptions(ctx, id, poll.options);
    return id;
};

/**
 * Changes `poll` to ask what `changes` asks, keeping its votes unless `reset`. If its end moves, it
 * hasn't ended yet.
 */
export const updatePoll = async (
    ctx: Context,
    poll: PollRow,
    changes: NewPoll,
    reset: boolean,
): Promise<void> => {
    const moves = poll.expires_at?.getTime() !== changes.expiresAt?.getTime();

    await ctx.db.updateTable("polls")
        .set({
            multiple: changes.multiple,
            hide_totals: changes.hideTotals,
            expires_at: changes.expiresAt,
            // Its voters are told again when it comes.
            ...moves ? { ended_at: null } : {},
            ...reset ? { voters_count: 0 } : {},
        })
        .where("id", "=", poll.id)
        .execute();
    if (!reset) return;

    await ctx.db.deleteFrom("poll_votes").where("poll_id", "=", poll.id).execute();
    await ctx.db.deleteFrom("poll_options").where("poll_id", "=", poll.id).execute();
    await insertOptions(ctx, poll.id, changes.options);
};

/**
 * Sets how many votes each option of the remote poll `pollId` has, in order, as its instance says.
 * How many accounts voted is unknown, as Versia doesn't say.
 */
export const setRemoteVotes = async (
    ctx: Context,
    pollId: string,
    votes: readonly number[],
): Promise<void> => {
    for (const [position, count] of votes.entries()) {
        await ctx.db.updateTable("poll_options")
            .set({ votes_count: count })
            .where("poll_id", "=", pollId)
            .where("position", "=", position)
            .execute();
    }

    await ctx.db.updateTable("polls").set({ voters_count: null }).where("id", "=", pollId)
        .execute();
};

export const deletePoll = async (ctx: Context, poll: PollRow): Promise<void> => {
    await ctx.db.deleteFrom("polls").where("id", "=", poll.id).execute();
};

/** The polls of those of `noteIds` that have one, with their options, by status. */
export const pollsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, PollWithOptions>> => {
    if (noteIds.length === 0) return new Map();

    const polls = await ctx.db.selectFrom("polls").selectAll()
        .where("note_id", "in", noteIds)
        .execute();
    if (polls.length === 0) return new Map();

    const options = await ctx.db.selectFrom("poll_options").selectAll()
        .where("poll_id", "in", polls.map((poll) => poll.id))
        .orderBy("position")
        .execute();

    return new Map(polls.map((poll) => [
        poll.note_id,
        { ...poll, options: options.filter((option) => option.poll_id === poll.id) },
    ]));
};

/** The poll of the status `noteId`, if it has one. */
export const pollOf = async (
    ctx: Context,
    noteId: string,
): Promise<PollWithOptions | undefined> => (await pollsOf(ctx, [noteId])).get(noteId);

export const findPoll = async (
    ctx: Context,
    id: string,
): Promise<PollWithOptions | undefined> => {
    const poll = await ctx.db.selectFrom("polls").selectAll().where("id", "=", id)
        .executeTakeFirst();
    return poll && await pollOf(ctx, poll.note_id);
};

/**
 * The options each of `accountIds` voted for in each of `pollIds` they voted in, in order, by
 * account, then by poll.
 */
export const votesAmong = async (
    ctx: Context,
    accountIds: readonly string[],
    pollIds: readonly string[],
): Promise<Map<string, Map<string, number[]>>> => {
    if (accountIds.length === 0 || pollIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("poll_votes")
        .select(["account_id", "poll_id", "choice"])
        .where("account_id", "in", accountIds)
        .where("poll_id", "in", pollIds)
        .orderBy("choice")
        .execute();

    const votes = new Map<string, Map<string, number[]>>();
    for (const row of rows) {
        const byPoll = votes.get(row.account_id) ?? new Map<string, number[]>();
        votes.set(
            row.account_id,
            byPoll.set(row.poll_id, [...byPoll.get(row.poll_id) ?? [], row.choice]),
        );
    }
    return votes;
};

/**
 * Adds `accountId`'s votes for `choices` in `poll`, counts them, and counts `accountId` as a voter
 * unless `voted` already. Returns the votes' ids, in the order of `choices`.
 */
export const insertVotes = async (
    ctx: Context,
    poll: PollRow,
    accountId: string,
    choices: readonly number[],
    voted: boolean,
): Promise<string[]> => {
    const ids = choices.map(() => ctx.ids());
    await ctx.db.insertInto("poll_votes")
        .values(choices.map((choice, index) => ({
            id: ids[index],
            poll_id: poll.id,
            account_id: accountId,
            choice,
            created_at: ctx.clock.now(),
        })))
        .execute();

    await ctx.db.updateTable("poll_options")
        .set({ votes_count: sql`votes_count + 1` })
        .where("poll_id", "=", poll.id)
        .where("position", "in", choices)
        .execute();

    if (voted) return ids;
    await ctx.db.updateTable("polls")
        .set({ voters_count: sql`voters_count + 1` })
        .where("id", "=", poll.id)
        .where("voters_count", "is not", null)
        .execute();
    return ids;
};

/** The votes of `ids`, as they were cast. */
export const findVotes = (ctx: Context, ids: readonly string[]): Promise<PollVoteRow[]> =>
    ids.length === 0
        ? Promise.resolve([])
        : ctx.db.selectFrom("poll_votes").selectAll().where("id", "in", ids).orderBy("choice")
            .execute();

/** The instances of the remote accounts that voted in `pollId`. */
export const voterInstances = async (ctx: Context, pollId: string): Promise<string[]> =>
    (await ctx.db.selectFrom("poll_votes")
        .innerJoin("accounts", "accounts.id", "poll_votes.account_id")
        .select("accounts.instance_id")
        .distinct()
        .where("poll_votes.poll_id", "=", pollId)
        .execute()).flatMap((row) => row.instance_id ?? []);

/**
 * Marks up to `limit` polls that have ended by now, but weren't marked yet, as ended, and returns
 * them, the first to end first.
 */
export const markEndedPolls = async (ctx: Context, limit: number): Promise<PollRow[]> => {
    const now = ctx.clock.now();
    // So that two jobs running at once never mark the same poll.
    const polls = await skippingLocked(
        ctx.db,
        ctx.db.selectFrom("polls").selectAll()
            .where("ended_at", "is", null)
            .where("expires_at", "<=", now)
            .orderBy("expires_at")
            .limit(limit),
    ).execute();
    if (polls.length === 0) return [];

    await ctx.db.updateTable("polls")
        .set({ ended_at: now })
        .where("id", "in", polls.map((poll) => poll.id))
        .execute();
    return polls;
};

/** The local accounts that voted in `pollId`. */
export const localVoterIds = async (ctx: Context, pollId: string): Promise<string[]> =>
    (await ctx.db.selectFrom("poll_votes")
        .innerJoin("accounts", "accounts.id", "poll_votes.account_id")
        .select("poll_votes.account_id")
        .distinct()
        .where("poll_votes.poll_id", "=", pollId)
        .where("accounts.instance_id", "is", null)
        .orderBy("poll_votes.account_id")
        .execute()).map((row) => row.account_id);
