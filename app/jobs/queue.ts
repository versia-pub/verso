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
    const now = ctx.clock.now();

    const inserted = await ctx.db.insertInto("jobs")
        .values({
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
        })
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .returning("id")
        .executeTakeFirst();

    if (inserted) await notify(ctx.db, jobsChannel, job.queue);
    return inserted?.id;
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
 * Leases up to `limit` due jobs from one queue, highest priority first, then oldest. Each claim
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
                .$if((options.skipGroups ?? []).length > 0, (query) =>
                    query.where((eb) =>
                        eb.or([
                            eb("group_key", "is", null),
                            eb("group_key", "not in", options.skipGroups ?? []),
                        ])
                    ))
                .orderBy("priority", "desc").orderBy("run_at").orderBy("id")
                .limit(options.limit)
                .$call((query) => skippingLocked(ctx.db, query)))
        .returningAll()
        .execute();

    return jobs.toSorted((a, b) =>
        b.priority - a.priority || a.run_at.getTime() - b.run_at.getTime() ||
        a.id.localeCompare(b.id)
    );
};

/**
 * Puts off every waiting job of `group` in `queue` until `runAt`, such as deliveries to an
 * instance that asked to be left alone until then. Jobs due later, or running, are left as they
 * are. Like `postpone`, it uses up no attempts.
 */
export const postponeGroup = async (
    ctx: Context,
    queue: string,
    group: string,
    runAt: Date,
): Promise<void> => {
    const now = ctx.clock.now();

    await ctx.db.updateTable("jobs")
        .set({ run_at: runAt })
        .where("queue", "=", queue)
        .where("group_key", "=", group)
        .where("run_at", "<", runAt)
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", "<", eb.ref("max_attempts")))
        .where((eb) =>
            eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)])
        )
        .execute();
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

/** How long a dead letter is kept, for someone to look at or retry. */
const deadLetterMs = 30 * 24 * 60 * 60 * 1000;

/** Deletes finished jobs that no longer need to be kept, and dead letters kept long enough. */
export const deleteExpiredJobs = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();

    await ctx.db.deleteFrom("jobs")
        .where("finished_at", "is not", null)
        .where("keep_until", "<=", now)
        .execute();

    await ctx.db.deleteFrom("jobs")
        .where("finished_at", "is", null)
        .where((eb) => eb("attempts", ">=", eb.ref("max_attempts")))
        .where("run_at", "<=", new Date(now.getTime() - deadLetterMs))
        .execute();
};

/**
 * Exponential backoff with jitter: about 30 seconds after the first attempt, doubling each time,
 * at most six hours. Each wait is scaled by a random factor between ½ and 1, so jobs that failed
 * together don't all retry together.
 */
export const backoffMs = (attempts: number, random: () => number = Math.random): number =>
    Math.min(30_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000) * (0.5 + random() / 2);

/**
 * Records a failed run. The job is retried after a backoff, or, once its attempts are used up,
 * stays in the table as a dead letter for a while.
 */
export const fail = async (
    ctx: Context,
    job: JobsTable,
    error: string,
    random?: () => number,
): Promise<void> => {
    const dead = job.attempts >= job.max_attempts;
    const now = ctx.clock.now().getTime();

    await ctx.db.updateTable("jobs")
        .set({
            lease_owner: null,
            lease_expires_at: null,
            last_error: error,
            run_at: new Date(dead ? now : now + backoffMs(job.attempts, random)),
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
export const giveUp = async (ctx: Context, job: JobsTable, error: string): Promise<void> => {
    await ctx.db.updateTable("jobs")
        .set((eb) => ({
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
