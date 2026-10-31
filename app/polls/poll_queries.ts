import { type Selectable, sql } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { PollOptionsTable, PollsTable } from "./tables.ts";

export type PollRow = Selectable<PollsTable>;
export type PollOptionRow = Selectable<PollOptionsTable>;

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

/** Adds a poll with no votes to the status `noteId`. */
export const insertPoll = async (ctx: Context, noteId: string, poll: NewPoll): Promise<void> => {
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
};

/** Changes `poll` to ask what `changes` asks, keeping its votes unless `reset`. */
export const updatePoll = async (
    ctx: Context,
    poll: PollRow,
    changes: NewPoll,
    reset: boolean,
): Promise<void> => {
    await ctx.db.updateTable("polls")
        .set({
            multiple: changes.multiple,
            hide_totals: changes.hideTotals,
            expires_at: changes.expiresAt,
            ...reset ? { voters_count: 0 } : {},
        })
        .where("id", "=", poll.id)
        .execute();
    if (!reset) return;

    await ctx.db.deleteFrom("poll_votes").where("poll_id", "=", poll.id).execute();
    await ctx.db.deleteFrom("poll_options").where("poll_id", "=", poll.id).execute();
    await insertOptions(ctx, poll.id, changes.options);
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

/** The options `accountId` voted for in each of `pollIds` they voted in, in order. */
export const votesAmong = async (
    ctx: Context,
    accountId: string,
    pollIds: readonly string[],
): Promise<Map<string, number[]>> => {
    if (pollIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("poll_votes")
        .select(["poll_id", "choice"])
        .where("account_id", "=", accountId)
        .where("poll_id", "in", pollIds)
        .orderBy("choice")
        .execute();

    const votes = new Map<string, number[]>();
    for (const row of rows) votes.set(row.poll_id, [...votes.get(row.poll_id) ?? [], row.choice]);
    return votes;
};

/**
 * Adds `accountId`'s votes for `choices` in `poll`, counts them, and counts `accountId` as a voter
 * unless `voted` already.
 */
export const insertVotes = async (
    ctx: Context,
    poll: PollRow,
    accountId: string,
    choices: readonly number[],
    voted: boolean,
): Promise<void> => {
    await ctx.db.insertInto("poll_votes")
        .values(choices.map((choice) => ({
            id: ctx.ids(),
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

    if (voted) return;
    await ctx.db.updateTable("polls")
        .set({ voters_count: sql`voters_count + 1` })
        .where("id", "=", poll.id)
        .where("voters_count", "is not", null)
        .execute();
};
