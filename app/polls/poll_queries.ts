import { type Selectable, sql } from "kysely";
import { skippingLocked } from "../db/locking.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import type { PollBallotsTable, PollOptionsTable, PollsTable } from "./tables.ts";

export type PollRow = Selectable<PollsTable>;
export type PollOptionRow = Selectable<PollOptionsTable>;
export type PollBallotRow = Selectable<PollBallotsTable>;

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
 * Changes the end and the hidden totals of `poll` to those `changes` has. Its options and votes stay
 * as they are, since they can't change. If its end moves, it hasn't ended yet.
 */
export const updatePoll = async (
    ctx: Context,
    poll: PollRow,
    changes: NewPoll,
): Promise<void> => {
    const moves = poll.expires_at?.getTime() !== changes.expiresAt?.getTime();

    await ctx.db.updateTable("polls")
        .set({
            hide_totals: changes.hideTotals,
            expires_at: changes.expiresAt,
            // Its voters are told again when the new end comes.
            ...moves ? { ended_at: null } : {},
        })
        .where("id", "=", poll.id)
        .execute();
};

/**
 * Sets how many votes each option of the remote poll `pollId` has, in order, and how many accounts
 * voted, as its instance reports them. `voters` is `null` if it didn't say.
 */
export const setRemoteVotes = async (
    ctx: Context,
    pollId: string,
    votes: readonly number[],
    voters: number | null,
): Promise<void> => {
    for (const [position, count] of votes.entries()) {
        await ctx.db.updateTable("poll_options")
            .set({ votes_count: count })
            .where("poll_id", "=", pollId)
            .where("position", "=", position)
            .execute();
    }

    await ctx.db.updateTable("polls").set({ voters_count: voters }).where("id", "=", pollId)
        .execute();
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

/** The poll `id`, with its options, if there is one. */
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
 * Adds the votes of the local user `accountId` for `choices` in `poll`, and counts them. Their
 * ballot is made if `voted` isn't so, and then they count as a voter. Otherwise its `updated_at`
 * is set.
 */
export const insertVotes = async (
    ctx: Context,
    poll: PollRow,
    accountId: string,
    choices: readonly number[],
    voted: boolean,
): Promise<void> => {
    await insertChoices(ctx, poll.id, accountId, choices);
    await ctx.db.updateTable("poll_options")
        .set({ votes_count: sql`votes_count + 1` })
        .where("poll_id", "=", poll.id)
        .where("position", "in", choices)
        .execute();

    if (voted) {
        await ctx.db.updateTable("poll_ballots")
            .set({ updated_at: ctx.clock.now() })
            .where("poll_id", "=", poll.id)
            .where("account_id", "=", accountId)
            .execute();
        return;
    }

    await insertBallot(ctx, {
        id: ctx.ids(),
        poll_id: poll.id,
        account_id: accountId,
        remote_id: null,
        created_at: ctx.clock.now(),
        updated_at: null,
    });
    await ctx.db.updateTable("polls")
        .set({ voters_count: sql`voters_count + 1` })
        .where("id", "=", poll.id)
        .where("voters_count", "is not", null)
        .execute();
};

/** Adds one vote of `accountId` in `pollId` for each of `choices`. */
const insertChoices = async (
    ctx: Context,
    pollId: string,
    accountId: string,
    choices: readonly number[],
): Promise<void> => {
    await ctx.db.insertInto("poll_votes")
        .values(choices.map((choice) => ({
            id: ctx.ids(),
            poll_id: pollId,
            account_id: accountId,
            choice,
            created_at: ctx.clock.now(),
        })))
        .execute();
};

/** Adds `ballot`, without its votes. */
const insertBallot = async (ctx: Context, ballot: PollBallotRow): Promise<void> => {
    await ctx.db.insertInto("poll_ballots").values(ballot).execute();
};

/** The ballot `id`, if there is one. */
export const findBallot = (ctx: Context, id: string): Promise<PollBallotRow | undefined> =>
    ctx.db.selectFrom("poll_ballots").selectAll().where("id", "=", id).executeTakeFirst();

/** The ballot of `accountId` in the poll `pollId`, if they have one. */
export const ballotOf = (
    ctx: Context,
    pollId: string,
    accountId: string,
): Promise<PollBallotRow | undefined> =>
    ctx.db.selectFrom("poll_ballots").selectAll()
        .where("poll_id", "=", pollId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** The ballot of `accountId` that is the Vote `remoteId` on their instance, if they have one. */
export const remoteBallotOf = (
    ctx: Context,
    accountId: string,
    remoteId: string,
): Promise<PollBallotRow | undefined> =>
    ctx.db.selectFrom("poll_ballots").selectAll()
        .where("account_id", "=", accountId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/** The ballot that is the Vote `remoteId` of an account of the instance `instanceId`, if any. */
export const findRemoteBallot = (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<PollBallotRow | undefined> =>
    ctx.db.selectFrom("poll_ballots")
        .innerJoin("accounts", "accounts.id", "poll_ballots.account_id")
        .selectAll("poll_ballots")
        .where("poll_ballots.remote_id", "=", remoteId)
        .where("accounts.instance_id", "=", instanceId)
        .executeTakeFirst();

/** The options `ballot` chose, in order. */
export const choicesOf = async (ctx: Context, ballot: PollBallotRow): Promise<number[]> =>
    (await ctx.db.selectFrom("poll_votes").select("choice")
        .where("poll_id", "=", ballot.poll_id)
        .where("account_id", "=", ballot.account_id)
        .orderBy("choice")
        .execute()).map((row) => row.choice);

/**
 * Gives `ballot` the choices `choices` in place of its own, and sets its `updated_at`. Counts stay
 * as they are until {@link recountPoll}.
 */
export const setChoices = async (
    ctx: Context,
    ballot: PollBallotRow,
    choices: readonly number[],
    updatedAt: Date | null,
): Promise<void> => {
    await ctx.db.deleteFrom("poll_votes")
        .where("poll_id", "=", ballot.poll_id)
        .where("account_id", "=", ballot.account_id)
        .execute();
    await insertChoices(ctx, ballot.poll_id, ballot.account_id, choices);

    await setBallotUpdatedAt(ctx, ballot, updatedAt);
};

/** Sets when `ballot` was last updated, as its voter's instance says. */
export const setBallotUpdatedAt = async (
    ctx: Context,
    ballot: PollBallotRow,
    updatedAt: Date | null,
): Promise<void> => {
    await ctx.db.updateTable("poll_ballots").set({ updated_at: updatedAt })
        .where("id", "=", ballot.id)
        .execute();
};

/** Adds `ballot` of a remote voter, and its votes for `choices`. Counts wait for a recount. */
export const insertRemoteBallot = async (
    ctx: Context,
    ballot: PollBallotRow,
    choices: readonly number[],
): Promise<void> => {
    await insertBallot(ctx, ballot);
    await insertChoices(ctx, ballot.poll_id, ballot.account_id, choices);
};

/** Deletes `ballot` and its votes. Counts wait for a recount. */
export const deleteBallot = async (ctx: Context, ballot: PollBallotRow): Promise<void> => {
    await ctx.db.deleteFrom("poll_votes")
        .where("poll_id", "=", ballot.poll_id)
        .where("account_id", "=", ballot.account_id)
        .execute();
    await ctx.db.deleteFrom("poll_ballots").where("id", "=", ballot.id).execute();
};

/**
 * Sets every option's `votes_count` of the poll `pollId` and its `voters_count` from the votes and
 * ballots stored. A change received from a remote voter can move any of them, so they are counted
 * again rather than adjusted.
 */
export const recountPoll = async (ctx: Context, pollId: string): Promise<void> => {
    await ctx.db.updateTable("poll_options")
        .set({
            votes_count: sql`(
                select count(*) from poll_votes
                where poll_votes.poll_id = poll_options.poll_id
                    and poll_votes.choice = poll_options.position
            )`,
        })
        .where("poll_id", "=", pollId)
        .execute();

    await ctx.db.updateTable("polls")
        .set({
            voters_count: sql`(
                select count(*) from poll_ballots where poll_ballots.poll_id = polls.id
            )`,
        })
        .where("id", "=", pollId)
        .execute();
};

/** The instances of the remote accounts that voted in `pollId`, other than `skipped`. */
export const voterInstances = async (
    ctx: Context,
    pollId: string,
    skipped?: AccountIdQuery,
): Promise<string[]> =>
    (await ctx.db.selectFrom("poll_votes")
        .innerJoin("accounts", "accounts.id", "poll_votes.account_id")
        .select("accounts.instance_id")
        .distinct()
        .where("poll_votes.poll_id", "=", pollId)
        .$call((query) =>
            skipped === undefined ? query : query.where("poll_votes.account_id", "not in", skipped)
        )
        .execute()).flatMap((row) => row.instance_id ?? []);

/**
 * Marks up to `limit` polls that have ended but aren't marked yet, and returns them, the first to
 * end first.
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
