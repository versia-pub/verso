/**
 * Rate limits: how many requests a client may make in a window of time. Counts live in a store,
 * in memory or shared between servers, and are reported in the headers Versia requires.
 * @see https://datatracker.ietf.org/doc/html/draft-polli-ratelimit-headers-02
 * @module
 */
import type { Context as HonoContext, Env, MiddlewareHandler } from "@hono/hono";
import type { Clock } from "../kernel/clock.ts";
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

/** The limit every client is held to, and where their counts are kept. */
export type RateLimits = {
    readonly store: RateLimitStore;
    readonly policy: Policy;
};

/**
 * Counts each request against the client `keyOf` names, and refuses it once they are over the
 * limit. Every reply says how much of the quota is left.
 */
export const rateLimit = <E extends Env>(
    clock: Clock,
    limits: RateLimits,
    keyOf: (c: HonoContext<E>) => Promise<string>,
): MiddlewareHandler<E> =>
async (c, next) => {
    const quota = await consume(limits.store, clock, limits.policy, await keyOf(c));

    c.header("ratelimit-limit", `${quota.limit}, ${quota.limit};w=${quota.windowSeconds}`);
    c.header("ratelimit-remaining", String(quota.remaining));
    c.header("ratelimit-reset", String(quota.resetSeconds));

    if (!quota.allowed) {
        // The same moment as RateLimit-Reset, as the draft asks.
        c.header("retry-after", String(quota.resetSeconds));
        throw new TooManyRequests();
    }

    await next();
};
