/**
 * Moving what local accounts have with a remote account that moved to the account it moved to, as
 * Mastodon does: follows, and the lists they put it in, then account notes, blocks and mutes. Each
 * step is a job of its own, retried on its own, which only does what isn't done yet, so a step for
 * something else, such as statuses, is another subscriber with its own job.
 * @see https://versia.pub/extensions/migration
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/workers/move_worker.rb
 * @module
 */
import { z } from "zod";
import { type AccountRow, findAccount } from "../accounts/account_queries.ts";
import { isAccountMoved } from "../accounts/events.ts";
import { batchSize } from "../db/batches.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { copyListAccounts } from "../lists/list_queries.ts";
import { accountNoteLimit } from "./account_notes.ts";
import { accountNotesAbout, accountNotesOn, setAccountNote } from "./account_note_queries.ts";
import { blockerIdsAfter, insertBlock } from "./block_queries.ts";
import { blockingAny } from "./blocks.ts";
import { follow, unfollow } from "./follows.ts";
import { followsFrom, localFollowsOf } from "./follow_queries.ts";
import { mutesAfter, mutesOf, upsertMute } from "./mute_queries.ts";

/** The queue of the jobs that move what local accounts have with an account that moved. */
export const moveQueue = "account-moves";

/** What each step moves, from the account that moved to the one it moved to. */
type Step = (ctx: Context, from: AccountRow, to: AccountRow) => Promise<void>;

const MoveJob = z.object({
    step: z.enum(["follows", "relationships"]),
    accountId: z.string(),
    movedToId: z.string(),
});

/**
 * Fetches rows a batch at a time, after the cursor of the last one of the batch before, and runs
 * `each` on every batch in a transaction of its own, until there are no more rows.
 */
const inBatches = async <Row>(
    ctx: Context,
    fetch: (after: string) => Promise<readonly Row[]>,
    cursorOf: (row: Row) => string,
    each: (tx: Context, rows: readonly Row[]) => Promise<void>,
): Promise<void> => {
    for (let after = "";;) {
        const rows = await fetch(after);
        if (rows.length === 0) return;
        after = cursorOf(rows[rows.length - 1]);

        await ctx.transaction((tx) => each(tx, rows));
    }
};

/**
 * Moves the local followers of `from` to `to`, with the same options, and puts `to` in the lists
 * that have `from` because of the follow, then has them unfollow `from`. A follower that can't
 * follow `to`, or blocks it, keeps following `from`.
 */
const moveFollows: Step = async (ctx, from, to) => {
    const target = ctx.db.selectFrom("accounts").select("id as account_id")
        .where("id", "=", to.id);

    await inBatches(
        ctx,
        (after) => localFollowsOf(ctx, from.id, after, batchSize),
        (row) => row.follower_id,
        async (tx, follows) => {
            const ids = follows.map((row) => row.follower_id);
            const blocking = await blockingAny(tx, ids, target);

            for (const old of follows.filter((row) => !blocking.has(row.follower_id))) {
                const result = await follow(tx, old.follower_id, to.id, {
                    showReblogs: old.show_reblogs,
                    notify: old.notify,
                    languages: old.languages,
                });
                if (result !== "following" && result !== "requested") continue;

                const [moved] = await followsFrom(tx, old.follower_id, [to.id]);
                await copyListAccounts(tx, old.id, { accountId: to.id, followId: moved.id });
                await unfollow(tx, old.follower_id, from.id);
            }
        },
    );
};

/**
 * Adds what `accountId` noted about the account `to` moved from, `comment`, after `text`, to what
 * it notes about `to`, unless it already has, or it would be too long.
 */
const addNote = async (
    ctx: Context,
    accountId: string,
    to: AccountRow,
    text: string,
    comment: string,
) => {
    const existing = (await accountNotesOn(ctx, accountId, [to.id])).get(to.id);
    if (existing?.includes(text)) return;

    const note = existing === undefined ? [text, comment] : [text, comment, "\n", existing];
    const joined = note.join("\n");

    if ([...joined].length <= accountNoteLimit) {
        await setAccountNote(ctx, accountId, to.id, joined);
    } else if (existing === undefined) {
        await setAccountNote(ctx, accountId, to.id, comment);
    }
};

/** Copies what local accounts noted about `from` to `to`, saying where it came from. */
const copyNotes: Step = async (ctx, from, to) => {
    const text = `This user moved from ${acctOf(from)}, here were your previous notes about them:`;

    await inBatches(
        ctx,
        (after) => accountNotesAbout(ctx, from.id, after, batchSize),
        (note) => note.account_id,
        async (tx, notes) => {
            for (const note of notes) await addNote(tx, note.account_id, to, text, note.comment);
        },
    );
};

/** Which of `accountIds` follow, or asked to follow, `from` or `to`. */
const followingEither = async (
    ctx: Context,
    accountIds: readonly string[],
    from: AccountRow,
    to: AccountRow,
) => {
    const following = new Set<string>();

    for (const id of accountIds) {
        if ((await followsFrom(ctx, id, [from.id, to.id])).length > 0) following.add(id);
    }

    return following;
};

/**
 * Has the accounts that block `from` block `to` too, and note why if they have no note on it,
 * unless they follow either.
 */
const moveBlocks: Step = async (ctx, from, to) => {
    const text = `This user moved from ${acctOf(from)}, which you had blocked.`;

    await inBatches(
        ctx,
        (after) => blockerIdsAfter(ctx, from.id, after, batchSize),
        (id) => id,
        async (tx, ids) => {
            const following = await followingEither(tx, ids, from, to);

            for (const id of ids.filter((id) => !following.has(id))) {
                await insertBlock(tx, id, to.id);
                if ((await accountNotesOn(tx, id, [to.id])).size === 0) {
                    await setAccountNote(tx, id, to.id, text);
                }
            }
        },
    );
};

/**
 * Has the accounts that mute `from` mute `to` too, for good, and note why if they have no note on
 * it, unless they already mute it or follow either.
 */
const moveMutes: Step = async (ctx, from, to) => {
    const text = `This user moved from ${acctOf(from)}, which you had muted.`;

    await inBatches(
        ctx,
        (after) => mutesAfter(ctx, from.id, after, batchSize),
        (mute) => mute.account_id,
        async (tx, mutes) => {
            const ids = mutes.map((mute) => mute.account_id);
            const following = await followingEither(tx, ids, from, to);

            for (const mute of mutes) {
                const id = mute.account_id;
                if (following.has(id) || (await mutesOf(tx, id, [to.id])).size > 0) continue;

                await upsertMute(tx, id, to.id, {
                    notifications: mute.notifications,
                    expiresAt: null,
                });
                if ((await accountNotesOn(tx, id, [to.id])).size === 0) {
                    await setAccountNote(tx, id, to.id, text);
                }
            }
        },
    );
};

/** The `acct` of `account`: its `username@domain`, or only its username if it is local. */
const acctOf = (account: AccountRow) =>
    account.domain === null ? account.username : `${account.username}@${account.domain}`;

/** Each step, by its name in jobs. Notes come first, so blocks and mutes don't add to them. */
const steps: Record<z.infer<typeof MoveJob>["step"], Step> = {
    follows: moveFollows,
    relationships: async (ctx, from, to) => {
        await copyNotes(ctx, from, to);
        await moveBlocks(ctx, from, to);
        await moveMutes(ctx, from, to);
    },
};

/** Queues a job for each step when an account moved. */
export const queueMoves = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isAccountMoved(event)) return;

    for (const step of MoveJob.shape.step.options) {
        const payload: z.infer<typeof MoveJob> = {
            step,
            accountId: event.accountId,
            movedToId: event.movedToId,
        };

        await enqueue(ctx, {
            queue: moveQueue,
            payload,
            dedupeKey: `move:${step}:${event.accountId}:${event.movedToId}`,
        });
    }
};

/**
 * Runs a step of a move, if both accounts are still there, and the account still says it moved to
 * the other, as a local user may cancel its move.
 */
export const moveHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = MoveJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a move job");
    const { step, accountId, movedToId } = payload.data;

    const from = await findAccount(ctx, accountId);
    const to = await findAccount(ctx, movedToId);
    if (from === undefined || to === undefined || from.moved_to_account_id !== to.id) return;

    await steps[step](ctx, from, to);
};
