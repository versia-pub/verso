import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import {
    oldRemoteNotesQuery,
    prunableNoteIds,
    type PruneCursor,
    uncountPrunedAuthors,
} from "./pruning_queries.ts";
import { deleteNotes, notesAmongQuery, uncountRepliesAmong } from "./removal_queries.ts";
import { uncountSharesAmong } from "./share_queries.ts";

/** Prunes old statuses from other instances, a batch at a time. */
export const pruneQueue = "remote-statuses-prune";

/** Starts {@link pruneQueue}'s work each day, if `remote_status_days` is set. */
export const pruneStartQueue = "remote-statuses-prune-start";

/** How many statuses one job looks at. */
const notesPerJob = 500;

/** How old the statuses a pass prunes are, and whether it keeps followed accounts'. */
export type Pruning = {
    readonly before: Date;
    readonly keepFollowed: boolean;
};

const PruneJob = z.object({
    before: z.iso.datetime().transform((value) => new Date(value)),
    keepFollowed: z.boolean(),
    after: z.object({ createdAt: z.iso.datetime(), id: z.string() }).nullable(),
});

const enqueueBatch = (ctx: Context, pruning: Pruning, after: PruneCursor | null) =>
    enqueue(ctx, {
        queue: pruneQueue,
        payload: {
            before: pruning.before.toISOString(),
            keepFollowed: pruning.keepFollowed,
            after: after && { createdAt: after.createdAt.toISOString(), id: after.id },
        },
        dedupeKey: `${pruneQueue}:${pruning.before.toISOString()}:${after?.id ?? ""}`,
    });

/**
 * Queues a pass over the remote statuses older than `remote_status_days`, keeping those by
 * accounts local users follow, if that is set.
 */
export const startPruning = async (ctx: Context): Promise<void> => {
    if (ctx.settings.remoteStatusMs === null) return;

    const before = new Date(ctx.clock.now().getTime() - ctx.settings.remoteStatusMs);
    await enqueueBatch(ctx, { before, keepFollowed: true }, null);
};

/** Prunes the next batch of a pass, and queues the job for the batch after, if there is one. */
export const pruneHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = PruneJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a prune job");

    const { after, ...pruning } = payload.data;
    await ctx.transaction(async (tx) => {
        const cursor = after && { createdAt: new Date(after.createdAt), id: after.id };
        const { last } = await pruneBatch(tx, pruning, cursor ?? undefined);
        if (last !== undefined) await enqueueBatch(tx, pruning, last);
    });
};

/**
 * Prunes every remote status `pruning` covers, a batch to a transaction, and returns how many it
 * deleted, not counting the boosts deleted with them.
 */
export const pruneRemoteNotes = async (ctx: Context, pruning: Pruning): Promise<number> => {
    let after: PruneCursor | undefined;
    let total = 0;
    while (true) {
        const { last, removed } = await ctx.transaction((tx) => pruneBatch(tx, pruning, after));
        total += removed;
        if (last === undefined) return total;

        after = last;
    }
};

/**
 * Deletes the prunable statuses among the next batch after `after`, decrementing the reply and boost
 * counts of the statuses they replied to and boosted, and the status counts of their authors and of
 * the authors of the boosts deleted with them, so that one fetched again isn't counted twice.
 * Returns the last status looked at, unless there were none, and how many were deleted.
 */
const pruneBatch = async (
    ctx: Context,
    pruning: Pruning,
    after: PruneCursor | undefined,
): Promise<{ last: PruneCursor | undefined; removed: number }> => {
    const batch = await oldRemoteNotesQuery(ctx, pruning.before, after, notesPerJob).execute();
    const lastRow = batch.at(-1);
    if (lastRow === undefined) return { last: undefined, removed: 0 };

    const ids = await prunableNoteIds(
        ctx,
        batch.map((row) => row.id),
        pruning.before,
        pruning.keepFollowed,
    );
    if (ids.length > 0) {
        const notes = notesAmongQuery(ctx, ids);
        await uncountRepliesAmong(ctx, notes);
        await uncountSharesAmong(ctx, notes);
        await uncountPrunedAuthors(ctx, notes);
        await deleteNotes(ctx, ids);
    }

    return { last: { createdAt: lastRow.created_at, id: lastRow.id }, removed: ids.length };
};
