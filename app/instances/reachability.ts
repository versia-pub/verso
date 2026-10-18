/**
 * Whether other instances can be reached, so that requests to one that is down wait for it, while
 * one at a time probes whether it is back: a circuit breaker.
 * @module
 */
import type { Context } from "../kernel/context.ts";

/** How many failures in a row park an instance. */
const threshold = 5;

/** How long a probe holds off other requests: longer than one request may take. */
const probeMs = 60_000;

/** How long to wait before probing an instance that failed `failures` times in a row. */
export const parkedForMs = (failures: number): number =>
    Math.min(60_000 * 2 ** Math.max(failures - threshold, 0), 60 * 60_000);

/**
 * When a request may be sent to `domain`, or `undefined` if it may now. Once a parked instance's
 * wait is over, the first to ask probes it, and the others wait for its answer.
 */
export const parkedUntil = async (ctx: Context, domain: string): Promise<Date | undefined> => {
    const now = ctx.clock.now();

    const row = await ctx.db.selectFrom("instances").select("parked_until")
        .where("domain", "=", domain).executeTakeFirst();
    if (!row?.parked_until) return undefined;
    if (row.parked_until > now) return row.parked_until;

    const hold = new Date(now.getTime() + probeMs);
    const probing = await ctx.db.updateTable("instances")
        .set({ parked_until: hold })
        .where("domain", "=", domain)
        .where("parked_until", "<=", now)
        .returning("id")
        .executeTakeFirst();

    return probing ? undefined : hold;
};

/**
 * Notes that `domain` couldn't be reached, again. Returns when it may next be tried, if it failed
 * often enough to be parked.
 */
export const recordUnreachable = async (
    ctx: Context,
    domain: string,
): Promise<Date | undefined> => {
    const row = await ctx.db.updateTable("instances")
        .set((eb) => ({ failures: eb("failures", "+", 1) }))
        .where("domain", "=", domain)
        .returning("failures")
        .executeTakeFirst();
    if (!row || row.failures < threshold) return undefined;

    const parkedUntil = new Date(ctx.clock.now().getTime() + parkedForMs(row.failures));
    await ctx.db.updateTable("instances").set({ parked_until: parkedUntil })
        .where("domain", "=", domain).execute();

    return parkedUntil;
};

/** Notes that `domain` answered. Returns whether it had been failing, or parked. */
export const recordReached = async (ctx: Context, domain: string): Promise<boolean> => {
    const row = await ctx.db.updateTable("instances")
        .set({ failures: 0, parked_until: null })
        .where("domain", "=", domain)
        .where((eb) => eb.or([eb("failures", ">", 0), eb("parked_until", "is not", null)]))
        .returning("id")
        .executeTakeFirst();

    return row !== undefined;
};
