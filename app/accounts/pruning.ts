import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import {
    type AccountPruneCursor,
    oldRemoteAccountsQuery,
    prunableAccountsQuery,
} from "./pruning_queries.ts";
import { removeRemoteAccounts } from "./remote.ts";

/** Prunes remote accounts that nothing here refers to, a batch at a time. */
export const accountPruneQueue = "remote-accounts-prune";

/** Starts {@link accountPruneQueue}'s work each day, if `remote_status_days` is set. */
export const accountPruneStartQueue = "remote-accounts-prune-start";

/** How many accounts one job looks at. */
const accountsPerJob = 500;

const PruneJob = z.object({
    before: z.iso.datetime().transform((value) => new Date(value)),
    after: z.object({ fetchedAt: z.iso.datetime(), id: z.string() }).nullable(),
});

const enqueueBatch = (ctx: Context, before: Date, after: AccountPruneCursor | null) =>
    enqueue(ctx, {
        queue: accountPruneQueue,
        payload: {
            before: before.toISOString(),
            after: after && { fetchedAt: after.fetchedAt.toISOString(), id: after.id },
        },
        dedupeKey: `${accountPruneQueue}:${before.toISOString()}:${after?.id ?? ""}`,
    });

/**
 * Queues a pass over the remote accounts last fetched more than `remote_status_days` ago, if that
 * is set, so that those whose statuses were pruned go too.
 */
export const startAccountPruning = async (ctx: Context): Promise<void> => {
    if (ctx.settings.remoteStatusMs === null) return;

    await enqueueBatch(
        ctx,
        new Date(ctx.clock.now().getTime() - ctx.settings.remoteStatusMs),
        null,
    );
};

/** Prunes the next batch of a pass, and queues the job for the batch after, if there is one. */
export const accountPruneHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = PruneJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't an account prune job");

    const { before, after } = payload.data;
    await ctx.transaction(async (tx) => {
        const cursor = after && { fetchedAt: new Date(after.fetchedAt), id: after.id };
        const { last } = await pruneBatch(tx, before, cursor ?? undefined);
        if (last !== undefined) await enqueueBatch(tx, before, last);
    });
};

/**
 * Prunes every remote account last fetched before `before` that nothing here refers to, a batch to
 * a transaction, and returns how many it deleted.
 */
export const pruneRemoteAccounts = async (ctx: Context, before: Date): Promise<number> => {
    let after: AccountPruneCursor | undefined;
    let total = 0;
    while (true) {
        const { last, removed } = await ctx.transaction((tx) => pruneBatch(tx, before, after));
        total += removed;
        if (last === undefined) return total;

        after = last;
    }
};

/**
 * Deletes the prunable accounts among the next batch after `after`, with their pictures, telling no
 * other instance. Returns the last account looked at, unless there were none, and how many were
 * deleted.
 */
const pruneBatch = async (
    ctx: Context,
    before: Date,
    after: AccountPruneCursor | undefined,
): Promise<{ last: AccountPruneCursor | undefined; removed: number }> => {
    const batch = await oldRemoteAccountsQuery(ctx, before, after, accountsPerJob).execute();
    const lastRow = batch.at(-1);
    if (lastRow === undefined) return { last: undefined, removed: 0 };

    const accounts = await prunableAccountsQuery(ctx, batch.map((row) => row.id)).execute();
    await removeRemoteAccounts(ctx, accounts);

    // Remote accounts are always fetched, so have a time it was.
    const fetchedAt = lastRow.fetched_at ?? new Date(0);
    return { last: { fetchedAt, id: lastRow.id }, removed: accounts.length };
};
