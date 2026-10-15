import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import { enqueue, type JobPayload } from "./queue.ts";
import { pause } from "./worker.ts";

/** Work that recurs: one job in `queue` for each minute, hour or day, in UTC. */
export type Task = {
    readonly queue: string;
    readonly every: "minute" | "hour" | "day";
    readonly payload?: JobPayload;
};

const periods = {
    minute: { ms: 60_000, keyLength: "2026-10-14T03:00".length },
    hour: { ms: 60 * 60_000, keyLength: "2026-10-14T03".length },
    day: { ms: 24 * 60 * 60_000, keyLength: "2026-10-14".length },
};

/**
 * Enqueues each task's job for the current period, such as `cleanup:2026-10-14T03`. Every node
 * may call it, any number of times: the dedupe key, kept until the period ends, means each
 * period's job is created only once.
 */
export const schedule = async (ctx: Context, tasks: readonly Task[]): Promise<void> => {
    const now = ctx.clock.now().getTime();

    for (const task of tasks) {
        const period = periods[task.every];
        const start = now - (now % period.ms);

        await enqueue(ctx, {
            queue: task.queue,
            payload: task.payload ?? {},
            dedupeKey: `${task.queue}:${new Date(start).toISOString().slice(0, period.keyLength)}`,
            keepUntil: new Date(start + period.ms),
        });
    }
};

/** Calls `schedule` now and then every `intervalMs` until `signal` aborts. */
export const runScheduler = async (
    ctx: Context,
    tasks: readonly Task[],
    options: { readonly intervalMs: number; readonly signal: AbortSignal },
): Promise<void> => {
    const logger = getLogger(["verso", "jobs", "scheduler"]);

    while (!options.signal.aborted) {
        try {
            await schedule(ctx, tasks);
        } catch (error) {
            logger.error("Couldn't schedule jobs: {error}", { error });
        }

        await pause(options.intervalMs, options.signal);
    }
};
