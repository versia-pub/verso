import { batchesOf } from "../db/batches.ts";
import { skippingLocked } from "../db/locking.ts";
import { notify } from "../db/notify.ts";
import type { Context } from "../kernel/context.ts";
import type { JobPayload, JobsTable } from "./tables.ts";
import { jobsChannel } from "./wakeups.ts";

export type NewJob = {
    readonly queue: string;
    readonly payload: JobPayload;
    readonly priority?: number;
    /** Defaults to now. */
    readonly runAt?: Date;
    readonly maxAttempts?: number;
    /** While a job with this key is queued, enqueueing another with the same key does nothing. */
    readonly dedupeKey?: string;
    /** Puts it in a group, such as the instance it is for, which its queue may limit. */
    readonly group?: string;
    /** Keeps the job once finished, and with it its dedupe key, until then. */
    readonly keepUntil?: Date;
    /**
     * Whether to wake idle workers on Postgres at once, rather than on their next poll, which is
     * the default. Each wakeup is a notification, and Postgres commits those one at a time, so
     * busy queues, whose workers poll soon anyway, are better off without.
     */
    readonly wake?: boolean;
};

/** A new job as a row, due now unless it says otherwise. */
const rowOf = (ctx: Context, job: NewJob) => {
    const now = ctx.clock.now();

    return {
        id: ctx.ids(),
        queue: job.queue,
        payload: job.payload,
        priority: job.priority ?? 0,
        run_at: job.runAt ?? now,
        attempts: 0,
        max_attempts: job.maxAttempts ?? 10,
        lease_owner: null,
        lease_expires_at: null,
        dedupe_key: job.dedupeKey ?? null,
        group_key: job.group ?? null,
        last_error: null,
        created_at: now,
        keep_until: job.keepUntil ?? null,
        finished_at: null,
    };
};

/**
 * Adds a job inside the caller's unit of work, so it exists exactly when the change that caused
 * it commits, and wakes idle workers on Postgres once it does. Returns its id, or `undefined`
 * when its dedupe key is already queued.
 */
export const enqueue = async (
    ctx: Context,
    job: NewJob,
): Promise<string | undefined> => {
    const inserted = await ctx.db.insertInto("jobs")
        .values(rowOf(ctx, job))
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .returning("id")
        .executeTakeFirst();

    if (inserted && job.wake !== false) await notify(ctx.db, jobsChannel, job.queue);
    return inserted?.id;
};

/** Adds several jobs as {@link enqueue} adds one, in as few queries as it can. */
export const enqueueAll = async (ctx: Context, jobs: readonly NewJob[]): Promise<void> => {
    const woken = new Set<string>();

    for (const batch of batchesOf(jobs)) {
        const inserted = await ctx.db.insertInto("jobs")
            .values(batch.map((job) => rowOf(ctx, job)))
            .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
            .returning("queue")
            .execute();
        for (const row of inserted) woken.add(row.queue);
    }

    // A queue is woken if any job it got asks to be.
    const waking = new Set(jobs.filter((job) => job.wake !== false).map((job) => job.queue));

    for (const queue of woken) if (waking.has(queue)) await notify(ctx.db, jobsChannel, queue);
};

export type ClaimOptions = {
    readonly queue: string;
    /** Names the worker in `lease_owner`, for finding who holds a job. */
    readonly worker: string;
    readonly limit: number;
    /** How long the worker has to finish before the job can be claimed again. */
    readonly leaseMs: number;
    /** Groups whose jobs aren't claimed, such as ones already running all they may. */
    readonly skipGroups?: readonly string[];
};

/**
 * Leases up to `limit` due jobs from one queue, highest priority first, then the first made, so a
 * group's jobs run in the order they were made, but for groups that are paused. Each claim
 * uses up an attempt. A job whose lease expired, say because its worker crashed, is due again, so
 * a job may run more than once and every handler must be idempotent.
 */
export const claim = async (ctx: Context, options: ClaimOptions): Promise<JobsTable[]> => {
    const now = ctx.clock.now();

    const jobs = await ctx.db.updateTable("jobs")
        .set((eb) => ({
            lease_owner: options.worker,
            lease_expires_at: new Date(now.getTime() + options.leaseMs),
            attempts: eb("attempts", "+", 1),
        }))
        .where("id", "in", (eb) =>
            eb.selectFrom("jobs").select("id")
                .where("queue", "=", options.queue)
                .where("run_at", "<=", now)
                .where("finished_at", "is", null)
                .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
                .where((eb) =>
                    eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)])
                )
                .where((eb) =>
                    eb.not(eb.exists(
                        eb.selectFrom("job_pauses").select("job_pauses.queue")
                            .whereRef("job_pauses.queue", "=", "jobs.queue")
                            .whereRef("job_pauses.group_key", "=", "jobs.group_key")
                            .where("job_pauses.until", ">", now),
                    ))
                )
                .$if((options.skipGroups ?? []).length > 0, (query) =>
                    query.where((eb) =>
                        eb.or([
                            eb("group_key", "is", null),
                            eb("group_key", "not in", options.skipGroups ?? []),
                        ])
                    ))
                .orderBy("priority", "desc").orderBy("id")
                .limit(options.limit)
                .$call((query) => skippingLocked(ctx.db, query)))
        .returningAll()
        .execute();

    return jobs.toSorted((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
};

/**
 * Gives a claimed job back without running it, as it was before the claim, so another worker, or
 * this one later, can claim it.
 */
export const release = async (ctx: Context, job: JobsTable): Promise<void> => {
    await ctx.db.updateTable("jobs")
        .set((eb) => ({
            lease_owner: null,
            lease_expires_at: null,
            attempts: eb("attempts", "-", 1),
        }))
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease_owner)
        .where("attempts", "=", job.attempts)
        .execute();
};

/**
 * Deletes a job that ran successfully, or marks it finished while it should be kept. Like `fail`,
 * it only touches the job while this claim still holds it, so a worker that lost its lease can't
 * undo someone else's newer claim.
 */
export const complete = async (ctx: Context, job: JobsTable): Promise<void> => {
    const now = ctx.clock.now();

    const stillClaimed = { id: job.id, lease_owner: job.lease_owner, attempts: job.attempts };

    if (job.keep_until !== null && job.keep_until > now) {
        await ctx.db.updateTable("jobs")
            .set({ lease_owner: null, lease_expires_at: null, finished_at: now })
            .where((eb) => eb.and(stillClaimed))
            .execute();
    } else {
        await ctx.db.deleteFrom("jobs").where((eb) => eb.and(stillClaimed)).execute();
    }
};

/**
 * Deletes finished jobs that no longer need to be kept, dead letters kept as long as settings say,
 * and pauses that ended.
 */
export const deleteExpiredJobs = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();

    await ctx.db.deleteFrom("jobs")
        .where("finished_at", "is not", null)
        .where("keep_until", "<=", now)
        .execute();

    await ctx.db.deleteFrom("jobs")
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", ">=", eb.ref("max_attempts")))
        .where("run_at", "<=", new Date(now.getTime() - ctx.settings.deadLetterMs))
        .execute();

    await ctx.db.deleteFrom("job_pauses").where("until", "<=", now).execute();
};

/**
 * What a job keeps once it dies: its payload, or what `deadPayload` keeps of it, and its dedupe
 * key only while it is kept anyway, so the same work can be queued again.
 */
const deadColumns = (ctx: Context, job: JobsTable, deadPayload?: DeadPayload) => ({
    ...deadPayload && { payload: deadPayload(job.payload) },
    ...!(job.keep_until !== null && job.keep_until > ctx.clock.now()) && { dedupe_key: null },
});

/** What a queue's dead letters keep of their payload, such as a summary of a large one. */
export type DeadPayload = (payload: JobPayload) => JobPayload;

/**
 * Exponential backoff with jitter: about 30 seconds after the first attempt, doubling each time,
 * at most six hours. Each wait is scaled by a random factor between ½ and 1, so jobs that failed
 * together don't all retry together.
 */
export const backoffMs = (attempts: number, random: () => number = Math.random): number =>
    Math.min(30_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000) * (0.5 + random() / 2);

/**
 * Records a failed run. The job is retried after a backoff, or, once its attempts are used up,
 * stays in the table as a dead letter for a while, as {@link deadColumns} keeps it.
 */
export const fail = async (
    ctx: Context,
    job: JobsTable,
    error: string,
    options: { readonly random?: () => number; readonly deadPayload?: DeadPayload } = {},
): Promise<void> => {
    const dead = job.attempts >= job.max_attempts;
    const now = ctx.clock.now().getTime();

    await ctx.db.updateTable("jobs")
        .set({
            ...dead && deadColumns(ctx, job, options.deadPayload),
            lease_owner: null,
            lease_expires_at: null,
            last_error: error,
            run_at: new Date(dead ? now : now + backoffMs(job.attempts, options.random)),
        })
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease_owner)
        .where("attempts", "=", job.attempts)
        .execute();
};

/**
 * Puts a job off until `runAt`, such as when the server it talks to asked to be left alone until
 * then. Waiting isn't failing, so the attempt this run used is given back.
 */
export const postpone = async (
    ctx: Context,
    job: JobsTable,
    runAt: Date,
    reason: string,
): Promise<void> => {
    await ctx.db.updateTable("jobs")
        .set((eb) => ({
            lease_owner: null,
            lease_expires_at: null,
            last_error: reason,
            attempts: eb("attempts", "-", 1),
            run_at: runAt,
        }))
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease_owner)
        .where("attempts", "=", job.attempts)
        .execute();
};

/**
 * Records a failed run that retrying can't fix, such as an entity that is invalid. The job becomes
 * a dead letter at once, kept for a while like any other.
 */
export const giveUp = async (
    ctx: Context,
    job: JobsTable,
    error: string,
    deadPayload?: DeadPayload,
): Promise<void> => {
    await ctx.db.updateTable("jobs")
        .set((eb) => ({
            ...deadColumns(ctx, job, deadPayload),
            lease_owner: null,
            lease_expires_at: null,
            last_error: error,
            attempts: eb.ref("max_attempts"),
            run_at: ctx.clock.now(),
        }))
        .where("id", "=", job.id)
        .where("lease_owner", "=", job.lease_owner)
        .where("attempts", "=", job.attempts)
        .execute();
};
