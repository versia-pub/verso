import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import {
    claim,
    complete,
    type DeadPayload,
    fail,
    giveUp,
    postpone,
    release,
} from "./job_queries.ts";
import type { JobsTable } from "./tables.ts";

/**
 * Runs one job. It may run more than once for the same job, so it must be idempotent. When it
 * throws, the job is retried later, unless it throws a `PermanentFailure`, or a `RetryAt` to say
 * when.
 */
export type Handler = (ctx: Context, job: JobsTable) => Promise<void>;

export type Queue = {
    readonly handler: Handler;
    /** How many of this queue's jobs one worker runs at a time. Each worker has as many. */
    readonly concurrency: number;
    /**
     * How many jobs of one group one worker runs at a time, such as deliveries to one instance, so
     * one group can't take every slot. Defaults to no limit. It is per worker: with three workers,
     * an instance can be sent three times as many at once.
     */
    readonly perGroup?: number;
    /** How long a job may run before another worker may claim it. Defaults to five minutes. */
    readonly leaseMs?: number;
    /** What its dead letters keep of their payload. Defaults to all of it. */
    readonly deadPayload?: DeadPayload;
};

export type WorkOptions = {
    /** Names this worker in job leases. */
    readonly worker: string;
    /** How long to wait before looking again when a queue has nothing due. */
    readonly pollMs: number;
    /** Stops claiming jobs; `work` resolves once the jobs already running have finished. */
    readonly signal: AbortSignal;
    /** Fires an event named after a queue when it gets a new job, to look before the next poll. */
    readonly wakeups?: EventTarget;
};

/** Thrown by a handler when retrying can't help, so the job isn't run again. */
export class PermanentFailure extends Error {
    override readonly name = "PermanentFailure";
}

/**
 * Thrown by a handler to run the job again at `runAt`, such as when a server asked to be left alone
 * until then. It doesn't count as a failed attempt.
 */
export class RetryAt extends Error {
    override readonly name = "RetryAt";

    constructor(readonly runAt: Date, reason: string) {
        super(reason);
    }
}

const logger = getLogger(["verso", "jobs"]);

const defaultLeaseMs = 5 * 60_000;

const errorText = (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);

/** Records how a run of `job` ended when its handler threw `error`. */
const recordFailure = async (
    ctx: Context,
    name: string,
    queue: Queue,
    job: JobsTable,
    error: unknown,
) => {
    if (error instanceof RetryAt) return await postpone(ctx, job, error.runAt, error.message);

    const permanent = error instanceof PermanentFailure;
    logger.warn("Job {id} in {queue} failed, {outcome}: {error}", {
        id: job.id,
        queue: name,
        outcome: permanent || job.attempts >= job.max_attempts ? "giving up" : "will retry",
        error,
    });

    if (permanent) await giveUp(ctx, job, errorText(error), queue.deadPayload);
    else await fail(ctx, job, errorText(error), { deadPayload: queue.deadPayload });
};

const runJob = async (ctx: Context, name: string, queue: Queue, job: JobsTable) => {
    try {
        await queue.handler(ctx, job);
        await complete(ctx, job);
    } catch (error) {
        try {
            await recordFailure(ctx, name, queue, job, error);
        } catch (error) {
            // The lease runs out and the job is claimed again, so nothing is lost.
            logger.error("Couldn't record the failure of job {id}: {error}", { id: job.id, error });
        }
    }
};

/** An event that ends a pause early. */
type Wakeup = { readonly events: EventTarget; readonly name: string };

/**
 * Waits until `ms` pass, `signal` aborts or one of `wakeups` fires, whichever comes first. Its
 * listeners are all removed when it ends, so pausing again and again doesn't pile them up.
 */
export const pause = (
    ms: number,
    signal: AbortSignal,
    wakeups: readonly Wakeup[] = [],
): Promise<void> =>
    new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            for (const { events, name } of wakeups) events.removeEventListener(name, done);
            resolve();
        };

        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done);
        for (const { events, name } of wakeups) events.addEventListener(name, done);
    });

const workQueue = async (ctx: Context, name: string, queue: Queue, options: WorkOptions) => {
    const running = new Set<Promise<void>>();

    // Fires when a job finishes, freeing a slot. The count catches one that finishes before the
    // pause starts listening.
    const finished = new EventTarget();
    let finishedCount = 0;

    const wakeups: Wakeup[] = [{ events: finished, name: "finished" }];
    if (options.wakeups) wakeups.push({ events: options.wakeups, name });

    // How many of each group's jobs are running.
    const groups = new Map<string, number>();
    const perGroup = queue.perGroup ?? Infinity;
    const isFull = (group: string) => (groups.get(group) ?? 0) >= perGroup;

    while (!options.signal.aborted) {
        const free = queue.concurrency - running.size;
        const finishedBefore = finishedCount;

        // Claiming no more than one group may run means giving few back when they share one.
        const limit = Math.min(free, perGroup);
        let jobs: JobsTable[] = [];
        if (limit > 0) {
            try {
                jobs = await claim(ctx, {
                    queue: name,
                    worker: options.worker,
                    limit,
                    leaseMs: queue.leaseMs ?? defaultLeaseMs,
                    skipGroups: [...groups.keys()].filter(isFull),
                });
            } catch (error) {
                logger.error("Couldn't claim jobs from {queue}: {error}", { queue: name, error });
            }
        }

        for (const job of jobs) {
            const group = job.group_key;
            if (group !== null && isFull(group)) {
                await release(ctx, job).catch((error) =>
                    // Its lease runs out, and it is claimed again then.
                    logger.error("Couldn't give back job {id}: {error}", { id: job.id, error })
                );
                continue;
            }
            if (group !== null) groups.set(group, (groups.get(group) ?? 0) + 1);

            const run = runJob(ctx, name, queue, job).finally(() => {
                if (group !== null) {
                    const left = (groups.get(group) ?? 1) - 1;
                    if (left === 0) groups.delete(group);
                    else groups.set(group, left);
                }

                running.delete(run);
                finishedCount++;
                finished.dispatchEvent(new Event("finished"));
            });
            running.add(run);
        }

        // A full batch means more may be due, and so may a slot freed meanwhile. Otherwise wait for
        // a free slot, a new job or the next poll.
        const waiting = limit <= 0 || jobs.length < limit;
        if (waiting && finishedCount === finishedBefore) {
            await pause(options.pollMs, options.signal, wakeups);
        }
    }

    await Promise.all(running);
};

/** Runs jobs from every queue until `signal` aborts, even when there are no queues. */
export const work = async (
    ctx: Context,
    queues: Record<string, Queue>,
    options: WorkOptions,
): Promise<void> => {
    const stopped = new Promise<void>((resolve) =>
        options.signal.aborted
            ? resolve()
            : options.signal.addEventListener("abort", () => resolve(), { once: true })
    );

    await Promise.all([
        stopped,
        ...Object.entries(queues).map(([name, queue]) => workQueue(ctx, name, queue, options)),
    ]);
};

/**
 * Runs due jobs one at a time, in the order a worker would claim them, until none are left, and
 * returns how many ran. Jobs enqueued along the way run too if they are due. A failed job waits
 * out its backoff, so with a fake clock this always ends. For tests, in place of `work`.
 */
export const drain = async (
    ctx: Context,
    queues: Record<string, Queue>,
    worker = "drain",
): Promise<number> => {
    let ran = 0;

    for (;;) {
        let claimed = 0;

        for (const [name, queue] of Object.entries(queues)) {
            const leaseMs = queue.leaseMs ?? defaultLeaseMs;
            for (const job of await claim(ctx, { queue: name, worker, limit: 1, leaseMs })) {
                await runJob(ctx, name, queue, job);
                claimed++;
            }
        }

        if (claimed === 0) return ran;
        ran += claimed;
    }
};
