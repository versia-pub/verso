import type { Context } from "../kernel/context.ts";

/**
 * Pauses `group` in `queue` until `runAt`, unless it is paused longer already: none of its jobs is
 * claimed until then, such as deliveries to an instance that asked to be left alone. Jobs running
 * are left as they are.
 */
export const postponeGroup = async (
    ctx: Context,
    queue: string,
    group: string,
    runAt: Date,
): Promise<void> => {
    await ctx.db.insertInto("job_pauses")
        .values({ queue, group_key: group, until: runAt })
        .onConflict((conflict) =>
            conflict.columns(["queue", "group_key"])
                .doUpdateSet({ until: runAt })
                .where("job_pauses.until", "<", runAt)
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
