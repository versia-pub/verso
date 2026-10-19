/**
 * Rate limits: how many requests a client may make in a window of time. Counts live in a store,
 * in memory or shared between servers, and are reported in the headers Versia requires.
 * @see https://datatracker.ietf.org/doc/html/draft-polli-ratelimit-headers-02
 * @module
 */
import type { Context as HonoContext, Env, MiddlewareHandler } from "@hono/hono";
import type { Clock } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { TooManyRequests } from "./errors.ts";

/** A key's requests in its current window. */
export type Hits = {
    readonly count: number;
    readonly resetsAt: Date;
};

/** Where request counts are kept. */
export type RateLimitStore = {
    /**
     * Counts one request for `key` and returns its count so far. A key's window starts at its
     * first request and lasts `windowMs`; after that, counting starts again from one. Windows start
     * when each client starts, so clients don't all come back at the same moment.
     */
    hit(key: string, windowMs: number): Promise<Hits>;
};

/** How often the memory store forgets windows that have ended. */
const sweepEveryMs = 60_000;

/** A store for one server, whose counts are lost on restart. */
export type MemoryRateLimitStore = RateLimitStore & {
    /** How many keys are held, for checking that ended windows are forgotten. */
    readonly size: number;
};

export const memoryRateLimitStore = (clock: Clock): MemoryRateLimitStore => {
    const windows = new Map<string, { count: number; resetsAt: Date }>();
    let nextSweep = clock.now().getTime() + sweepEveryMs;

    // Each client leaves a key behind, so ended windows must be dropped, or memory only grows.
    const sweep = (now: Date) => {
        if (now.getTime() < nextSweep) return;

        for (const [key, window] of windows) {
            if (window.resetsAt <= now) windows.delete(key);
        }
        nextSweep = now.getTime() + sweepEveryMs;
    };

    return {
        get size() {
            return windows.size;
        },

        hit: (key, windowMs) => {
            const now = clock.now();
            sweep(now);

            const current = windows.get(key);
            const window = current && current.resetsAt > now
                ? { count: current.count + 1, resetsAt: current.resetsAt }
                : { count: 1, resetsAt: new Date(now.getTime() + windowMs) };

            windows.set(key, window);
            return Promise.resolve(window);
        },
    };
};

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

/** At most `limit` requests every `windowSeconds`. */
export type Policy = {
    readonly limit: number;
    readonly windowSeconds: number;
};

/** Whether a request may go ahead, and what the headers say about the client's quota. */
export type Quota = {
    readonly allowed: boolean;
    readonly limit: number;
    readonly remaining: number;
    /** Whole seconds until the window ends, as `RateLimit-Reset` and `Retry-After` want. */
    readonly resetSeconds: number;
    readonly windowSeconds: number;
};

/** Counts a request for `key` under `policy`. */
export const consume = async (
    store: RateLimitStore,
    clock: Clock,
    policy: Policy,
    key: string,
): Promise<Quota> => {
    const hits = await store.hit(key, policy.windowSeconds * 1000);
    const untilReset = hits.resetsAt.getTime() - clock.now().getTime();

    return {
        allowed: hits.count <= policy.limit,
        limit: policy.limit,
        remaining: Math.max(policy.limit - hits.count, 0),
        resetSeconds: Math.max(Math.ceil(untilReset / 1000), 0),
        windowSeconds: policy.windowSeconds,
    };
};

/** The limits clients and other instances are held to, and where their counts are kept. */
export type RateLimits = {
    readonly store: RateLimitStore;
    /** For each client. */
    readonly policy: Policy;
    /** For each instance, on the routes it signs requests to. */
    readonly instancePolicy: Policy;
};

/**
 * Counts a request against `key` under `policy`, and refuses it once the key is over the limit.
 * Every reply says how much of the quota is left.
 */
export const checkRateLimit = async (
    c: HonoContext,
    clock: Clock,
    store: RateLimitStore,
    policy: Policy,
    key: string,
): Promise<void> => {
    const quota = await consume(store, clock, policy, key);

    c.header("ratelimit-limit", `${quota.limit}, ${quota.limit};w=${quota.windowSeconds}`);
    c.header("ratelimit-remaining", String(quota.remaining));
    c.header("ratelimit-reset", String(quota.resetSeconds));

    if (!quota.allowed) {
        // The same moment as RateLimit-Reset, as the draft asks.
        c.header("retry-after", String(quota.resetSeconds));
        throw new TooManyRequests();
    }
};

/** Counts each request against the client `keyOf` names, as `checkRateLimit` does. */
export const rateLimit = <E extends Env>(
    clock: Clock,
    limits: RateLimits,
    keyOf: (c: HonoContext<E>) => Promise<string>,
): MiddlewareHandler<E> =>
async (c, next) => {
    await checkRateLimit(c, clock, limits.store, limits.policy, await keyOf(c));
    await next();
};
