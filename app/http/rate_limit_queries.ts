import type { Context } from "../kernel/context.ts";
import type { RateLimitStore } from "./rate_limits.ts";

/**
 * A store shared by every server using the database. Each request is a write, which SQLite does one
 * at a time, so use it only with several web nodes on Postgres.
 */
export const databaseRateLimitStore = (ctx: Context): RateLimitStore => ({
    hit: async (key, windowMs) => {
        const now = ctx.clock.now();
        const resetsAt = new Date(now.getTime() + windowMs);

        // One statement, so requests at the same moment can't both start a window or lose a count.
        const row = await ctx.db.insertInto("rate_limits")
            .values({ key, count: 1, resets_at: resetsAt })
            .onConflict((conflict) =>
                conflict.column("key").doUpdateSet((eb) => {
                    const ongoing = eb("rate_limits.resets_at", ">", now);

                    return {
                        count: eb.case().when(ongoing).then(eb("rate_limits.count", "+", 1))
                            .else(1).end(),
                        resets_at: eb.case().when(ongoing).then(eb.ref("rate_limits.resets_at"))
                            .else(resetsAt).end(),
                    };
                })
            )
            .returning(["count", "resets_at"])
            .executeTakeFirstOrThrow();

        return { count: row.count, resetsAt: row.resets_at };
    },
});

/** Deletes the database store's windows that have ended. */
export const deleteEndedRateLimits = async (ctx: Context): Promise<void> => {
    await ctx.db.deleteFrom("rate_limits").where("resets_at", "<=", ctx.clock.now()).execute();
};
