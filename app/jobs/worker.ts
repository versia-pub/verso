import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import { claim, complete, fail, type JobsTable } from "./queue.ts";

/** Runs one job. It may run more than once for the same job, so it must be idempotent. */
export type Handler = (ctx: Context, job: JobsTable) => Promise<void>;

export type Queue = {
    readonly handler: Handler;
    /** How many of this queue's jobs one worker runs at a time. */
    readonly concurrency: number;
    /** How long a job may run before another worker may claim it. Defaults to five minutes. */
    readonly leaseMs?: number;
};

export type WorkOptions = {
    /** Names this worker in job leases. */
    readonly worker: string;
    /** How long to wait before looking again when a queue has nothing due. */
    readonly pollMs: number;
    /** Stops claiming jobs; `work` resolves once the jobs already running have finished. */
    readonly signal: AbortSignal;
};

const logger = getLogger(["verso", "jobs"]);

const errorText = (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);

const runJob = async (ctx: Context, name: string, queue: Queue, job: JobsTable) => {
    try {
        await queue.handler(ctx, job);
        await complete(ctx, job);
    } catch (error) {
        logger.warn("Job {id} in {queue} failed, {outcome}: {error}", {
            id: job.id,
            queue: name,
            outcome: job.attempts >= job.max_attempts ? "giving up" : "will retry",
            error,
        });
        try {
            await fail(ctx, job, errorText(error));
        } catch (error) {
            // The lease runs out and the job is claimed again, so nothing is lost.
            logger.error("Couldn't record the failure of job {id}: {error}", { id: job.id, error });
        }
    }
};

/** Waits until `ms` pass, `signal` aborts or one of `running` settles, whichever comes first. */
const pause = (ms: number, signal: AbortSignal, running: Iterable<Promise<void>>) =>
    new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done);
        for (const run of running) run.then(done);
    });

const workQueue = async (ctx: Context, name: string, queue: Queue, options: WorkOptions) => {
    const running = new Set<Promise<void>>();
    while (!options.signal.aborted) {
        const free = queue.concurrency - running.size;
        let jobs: JobsTable[] = [];
        if (free > 0) {
            try {
                jobs = await claim(ctx, {
                    queue: name,
                    worker: options.worker,
                    limit: free,
                    leaseMs: queue.leaseMs ?? 5 * 60_000,
                });
            } catch (error) {
                logger.error("Couldn't claim jobs from {queue}: {error}", { queue: name, error });
            }
        }
        for (const job of jobs) {
            const run = runJob(ctx, name, queue, job).finally(() => running.delete(run));
            running.add(run);
        }
        // A full batch means more may be due; otherwise wait for a free slot or the next poll.
        if (free === 0 || jobs.length < free) await pause(options.pollMs, options.signal, running);
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
