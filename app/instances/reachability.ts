/**
 * Whether other instances can be reached, so that requests to one that is down wait for it, while
 * one at a time probes whether it is back: a circuit breaker.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import {
    addFailure,
    clearFailures,
    findParkedUntil,
    holdForProbe,
    setParkedUntil,
} from "./reachability_queries.ts";

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

    const until = await findParkedUntil(ctx, domain);
    if (!until) return undefined;
    if (until > now) return until;

    const hold = new Date(now.getTime() + probeMs);
    return await holdForProbe(ctx, domain, now, hold) ? undefined : hold;
};

/** Whether `domain` is parked now, so that nothing but a delivery's probe is sent to it. */
export const isParked = async (ctx: Context, domain: string): Promise<boolean> => {
    const until = await findParkedUntil(ctx, domain) ?? null;
    return until !== null && until > ctx.clock.now();
};

/**
 * Notes that `domain` couldn't be reached, again, and since when it can't be if it could before.
 * Returns when it may next be tried, if it failed often enough to be parked.
 */
export const recordUnreachable = async (
    ctx: Context,
    domain: string,
): Promise<Date | undefined> => {
    const failures = await addFailure(ctx, domain);
    if (failures === undefined || failures < threshold) return undefined;

    const parkedUntil = new Date(ctx.clock.now().getTime() + parkedForMs(failures));
    await setParkedUntil(ctx, domain, parkedUntil);

    return parkedUntil;
};

/**
 * Notes that `domain` answered, or sent something. Returns whether it had been failing, or parked.
 */
export const recordReached = (ctx: Context, domain: string): Promise<boolean> =>
    clearFailures(ctx, domain);
