import type { SelectQueryBuilder } from "kysely";
import { batchesOf } from "../db/batches.ts";
import { countAll, readCount } from "../db/count.ts";
import { usesSqlite } from "../db/columns.ts";
import type { Database } from "../db/database.ts";
import { skippingLocked } from "../db/locking.ts";
import { notify } from "../db/notify.ts";
import type { Context } from "../kernel/context.ts";
import { publish } from "../kernel/pubsub.ts";
import { type PauseEnds, pausesOf } from "./job_pause_queries.ts";
import type { JobPayload, JobsTable } from "./tables.ts";
import { jobsChannel, jobWakeups } from "./wakeups.ts";

export type NewJob = {
    readonly queue: string;
    readonly payload: JobPayload;
    /** Defaults to now. If its group is paused until later, it runs once the pause ends. */
    readonly runAt?: Date;
    readonly maxAttempts?: number;
    /** While a job with this key is queued, enqueueing another with the same key does nothing. */
    readonly dedupeKey?: string;
    /** Puts it in a group, such as the instance it is for, which its queue may limit. */
    readonly group?: string;
    /** Retains the job after it finishes, and with it its dedupe key, until then. */
    readonly keepUntil?: Date;
    /**
     * Whether to wake idle workers on Postgres immediately, rather than on their next poll, which
     * is the default. Each wakeup is a notification, and Postgres commits those one at a time, so
     * busy queues, whose workers poll soon anyway, are better off without.
     */
    readonly wake?: boolean;
};

/**
 * A new job as a row, due now unless it says otherwise, or its group is paused until later, so that
 * it waits with the group's other jobs and runs after them.
 */
const rowOf = (ctx: Context, job: NewJob, pauses: PauseEnds) => {
    const now = ctx.clock.now();
    const runAt = job.runAt ?? now;
    const pauseEnd = job.group === undefined ? undefined : pauses.get(job.queue, job.group);

    return {
        id: ctx.ids(),
        queue: job.queue,
        payload: job.payload,
        run_at: pauseEnd && pauseEnd > runAt ? pauseEnd : runAt,
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
 * Wakes `queue`'s idle workers once the current transaction commits: on Postgres with a
 * notification, which workers in every process hear, and on SQLite, whose workers run in this
 * process, with a message.
 */
const wake = async (ctx: Context, queue: string) => {
    await notify(ctx.db, jobsChannel, queue);
    if (usesSqlite(ctx.db)) await publish(ctx, jobWakeups, queue);
};

/**
 * Adds a job inside the caller's transaction, so it exists exactly when the change that caused it
 * commits, and wakes idle workers once it does. Returns its id, or `undefined` when its
 * dedupe key is already queued.
 */
export const enqueue = async (
    ctx: Context,
    job: NewJob,
): Promise<string | undefined> => {
    const inserted = await ctx.db.insertInto("jobs")
        .values(rowOf(ctx, job, await pausesOf(ctx, [job])))
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .returning("id")
        .executeTakeFirst();

    if (inserted && job.wake !== false) await wake(ctx, job.queue);
    return inserted?.id;
};

/** Adds several jobs as {@link enqueue} adds one, in as few queries as it can. */
export const enqueueAll = async (ctx: Context, jobs: readonly NewJob[]): Promise<void> => {
    const woken = new Set<string>();

    for (const batch of batchesOf(jobs)) {
        const pauses = await pausesOf(ctx, batch);
        const inserted = await ctx.db.insertInto("jobs")
            .values(batch.map((job) => rowOf(ctx, job, pauses)))
            .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
            .returning("queue")
            .execute();
        for (const row of inserted) woken.add(row.queue);
    }

    // A queue is woken if any job it received asks to be.
    const waking = new Set(jobs.filter((job) => job.wake !== false).map((job) => job.queue));

    for (const queue of woken) if (waking.has(queue)) await wake(ctx, queue);
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

/** The jobs of `queue` due at `now` that aren't running, nor of a paused group. */
const dueJobs = (ctx: Context, queue: string, now: Date) =>
    ctx.db.selectFrom("jobs")
        .where("queue", "=", queue)
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
        );

/**
 * The ids of the jobs `claim` leases, in the order it leases them: due, not running, of a group that
 * isn't paused or skipped. Exported for the tests of its query plan.
 */
export const claimable = (
    ctx: Context,
    options: ClaimOptions,
    now: Date,
): SelectQueryBuilder<Database, "jobs", { id: string }> =>
    dueJobs(ctx, options.queue, now).select("id")
        .$if((options.skipGroups ?? []).length > 0, (query) =>
            query.where((eb) =>
                eb.or([
                    eb("group_key", "is", null),
                    eb("group_key", "not in", options.skipGroups ?? []),
                ])
            ))
        .orderBy("run_at").orderBy("id")
        .limit(options.limit)
        .$call((query) => skippingLocked(ctx.db, query));

/**
 * Leases up to `limit` due jobs from one queue, the longest due first, then the oldest, so a group's
 * jobs that waited out a pause together run in the order they were made. Jobs of a paused group are
 * skipped. Each claim uses up an attempt. A job whose lease expired, say because its worker crashed,
 * is due again, so a job may run more than once and every handler must be idempotent.
 */
export const claim = async (ctx: Context, options: ClaimOptions): Promise<JobsTable[]> => {
    const now = ctx.clock.now();

    // An update takes SQLite's only write lock even when it changes nothing, so look first.
    if (usesSqlite(ctx.db)) {
        const due = await claimable(ctx, { ...options, limit: 1 }, now).executeTakeFirst();
        if (due === undefined) return [];
    }

    const jobs = await ctx.db.updateTable("jobs")
        .set((eb) => ({
            lease_owner: options.worker,
            lease_expires_at: new Date(now.getTime() + options.leaseMs),
            attempts: eb("attempts", "+", 1),
        }))
        .where("id", "in", claimable(ctx, options, now))
        .returningAll()
        .execute();

    return jobs.toSorted((a, b) =>
        a.run_at.getTime() - b.run_at.getTime() || a.id.localeCompare(b.id)
    );
};

/**
 * When the next of `queue`'s jobs that aren't due yet becomes due, if it has any, so an idle worker
 * can look again then. Jobs already due aren't counted: those it couldn't claim, such as a paused
 * group's, wait for something else.
 */
export const nextRunAt = async (ctx: Context, queue: string): Promise<Date | undefined> => {
    const next = await ctx.db.selectFrom("jobs").select("run_at")
        .where("queue", "=", queue)
        .where("run_at", ">", ctx.clock.now())
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .orderBy("run_at")
        .limit(1)
        .executeTakeFirst();

    return next?.run_at;
};

/**
 * Releases a claimed job without running it, restoring it to its state before the claim, so another
 * worker, or this one later, can claim it.
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
 * Deletes a job that ran successfully, or marks it finished if it should be retained. Like `fail`,
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
 * The dead letters that died by `before`, which is when they were given up on. Exported for the
 * tests of its query plan.
 */
export const deadLetters = (
    ctx: Context,
    before: Date,
): SelectQueryBuilder<Database, "jobs", { id: string }> =>
    ctx.db.selectFrom("jobs").select("id")
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", ">=", eb.ref("max_attempts")))
        .where("run_at", "<=", before);

/**
 * How many jobs each queue has that are neither finished nor dead, due or not, running or not.
 * Exported for the tests of its query plan.
 */
export const waitingCounts = (
    ctx: Context,
): SelectQueryBuilder<Database, "jobs", { queue: string; count: number | string | bigint }> =>
    ctx.db.selectFrom("jobs").select(["queue", countAll])
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .groupBy("queue");

/** How many dead letters each queue has. Exported for the tests of its query plan. */
export const deadCounts = (
    ctx: Context,
    now: Date,
): SelectQueryBuilder<Database, "jobs", { queue: string; count: number | string | bigint }> =>
    deadLetters(ctx, now).clearSelect().select(["queue", countAll]).groupBy("queue");

/** What metrics say of one queue's jobs. */
export type QueueStats = {
    readonly queue: string;
    /** Jobs neither finished nor dead, due or not, running or not. */
    readonly waiting: number;
    /** When the job due longest, that no worker is running, became due, if one is. */
    readonly oldestDue: Date | undefined;
    readonly dead: number;
};

/**
 * Every queue with jobs waiting or dead, by name. The counts read the indexes of waiting and dead
 * jobs, and the job due longest is found as `claim` finds it, without locking it.
 */
export const queueStats = async (ctx: Context, now: Date): Promise<QueueStats[]> => {
    const waiting = new Map(
        (await waitingCounts(ctx).execute()).map((row) => [row.queue, readCount(row)]),
    );
    const dead = new Map(
        (await deadCounts(ctx, now).execute()).map((row) => [row.queue, readCount(row)]),
    );

    const stats = [];
    for (const queue of new Set([...waiting.keys(), ...dead.keys()].toSorted())) {
        const oldest = await dueJobs(ctx, queue, now).select("run_at")
            .orderBy("run_at")
            .limit(1)
            .executeTakeFirst();

        stats.push({
            queue,
            waiting: waiting.get(queue) ?? 0,
            oldestDue: oldest?.run_at,
            dead: dead.get(queue) ?? 0,
        });
    }

    return stats;
};

/**
 * Deletes finished jobs that no longer need to be retained, dead letters retained as long as the
 * settings say, and pauses that ended. Jobs go `batchSize` at a time, so no one delete holds the
 * table, or SQLite's write lock, for long.
 */
export const deleteExpiredJobs = async (ctx: Context, batchSize = 1000): Promise<void> => {
    const now = ctx.clock.now();
    const deadBefore = new Date(now.getTime() - ctx.settings.deadLetterMs);

    const expired = [
        ctx.db.selectFrom("jobs").select("id")
            .where("finished_at", "is not", null)
            .where("keep_until", "<=", now),
        deadLetters(ctx, deadBefore),
    ];

    for (const jobs of expired) {
        for (;;) {
            const deleted = await ctx.db.deleteFrom("jobs")
                .where("id", "in", jobs.limit(batchSize))
                .executeTakeFirst();
            if (deleted.numDeletedRows < BigInt(batchSize)) break;
        }
    }

    await ctx.db.deleteFrom("job_pauses").where("until", "<=", now).execute();
};

/**
 * What a job retains once it dies: its payload, or what `deadPayload` retains of it, and its dedupe
 * key only while it is retained anyway, so the same work can be queued again.
 */
const deadColumns = (ctx: Context, job: JobsTable, deadPayload?: DeadPayload) => ({
    ...deadPayload && { payload: deadPayload(job.payload) },
    ...!(job.keep_until !== null && job.keep_until > ctx.clock.now()) && { dedupe_key: null },
});

/** What a queue's dead letters retain of their payload, such as a summary of a large one. */
export type DeadPayload = (payload: JobPayload) => JobPayload;

/**
 * Exponential backoff with jitter: about 30 seconds after the first attempt, doubling each time, at
 * most six hours. Each wait is scaled by a random factor between ½ and 1, so jobs that failed
 * together don't all retry together.
 */
export const backoffMs = (attempts: number, random: () => number = Math.random): number =>
    Math.min(30_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000) * (0.5 + random() / 2);

/**
 * Records a failed run. The job is retried after a backoff, or, once its attempts are used up,
 * stays in the table as a dead letter for a while, as {@link deadColumns} retains it.
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
 * Postpones a job until `runAt`, such as when the server it talks to asked to be left alone until
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
 * Records a failed run that retrying can't fix, such as an invalid entity. The job becomes a dead
 * letter immediately, retained for a while like any other.
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
