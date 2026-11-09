import { batchesOf } from "../db/batches.ts";
import type { Context } from "../kernel/context.ts";

/** When the pauses of groups end, by queue and group. */
export type PauseEnds = {
    readonly get: (queue: string, group: string) => Date | undefined;
};

/** The ends of the pauses, not over yet, of the groups `jobs` are in. */
export const pausesOf = async (
    ctx: Context,
    jobs: readonly { readonly queue: string; readonly group?: string }[],
): Promise<PauseEnds> => {
    const ends = new Map<string, Date>();
    const key = (queue: string, group: string) => JSON.stringify([queue, group]);

    const groups = [...new Set(jobs.flatMap((job) => job.group ?? []))];
    for (const batch of batchesOf(groups)) {
        const rows = await ctx.db.selectFrom("job_pauses")
            .select(["queue", "group_key", "until"])
            .where("group_key", "in", batch)
            .where("until", ">", ctx.clock.now())
            .execute();
        for (const row of rows) ends.set(key(row.queue, row.group_key), row.until);
    }

    return { get: (queue, group) => ends.get(key(queue, group)) };
};

/**
 * Pauses `group` in `queue` until `runAt`, unless it is already paused for longer: none of its jobs
 * is claimed until then, such as deliveries to an instance that asked to be left alone. Its waiting
 * jobs are made due then, so claims don't read them meanwhile, and jobs enqueued while it lasts are
 * too. Running jobs are left as they are.
 */
export const postponeGroup = async (
    ctx: Context,
    queue: string,
    group: string,
    runAt: Date,
): Promise<void> => {
    const paused = await ctx.db.insertInto("job_pauses")
        .values({ queue, group_key: group, until: runAt })
        .onConflict((conflict) =>
            conflict.columns(["queue", "group_key"])
                .doUpdateSet({ until: runAt })
                .where("job_pauses.until", "<", runAt)
        )
        .returning("until")
        .executeTakeFirst();

    // Already paused for as long, so its jobs already wait.
    if (!paused) return;

    const now = ctx.clock.now();
    await ctx.db.updateTable("jobs")
        .set({ run_at: runAt })
        .where("queue", "=", queue)
        .where("group_key", "=", group)
        .where("run_at", "<", runAt)
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .where((eb) =>
            eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)])
        )
        .execute();
};

/**
 * Ends a pause of `group` in `queue` and makes its waiting jobs due now, such as deliveries to an
 * instance that is back. Running jobs are left as they are.
 */
export const resumeGroup = async (ctx: Context, queue: string, group: string): Promise<void> => {
    const now = ctx.clock.now();

    await ctx.db.deleteFrom("job_pauses")
        .where("queue", "=", queue)
        .where("group_key", "=", group)
        .execute();

    await ctx.db.updateTable("jobs")
        .set({ run_at: now })
        .where("queue", "=", queue)
        .where("group_key", "=", group)
        .where("run_at", ">", now)
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .where((eb) =>
            eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)])
        )
        .execute();
};
