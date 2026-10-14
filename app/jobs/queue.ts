import type { Context } from "../kernel/context.ts";

/** A row of the jobs table. */
export type JobsTable = {
    id: string;
    queue: string;
    payload: JobPayload;
    /** Higher runs first among jobs that are due. */
    priority: number;
    /** When the job may next run: when enqueued, or after a retry's backoff. */
    run_at: Date;
    attempts: number;
    /** A job that has used all its attempts is a dead letter, kept for inspection and retry. */
    max_attempts: number;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    dedupe_key: string | null;
    last_error: string | null;
    created_at: Date;
};

/** A JSON object, serialised when enqueued, so later changes can't alter a job already queued. */
export type JobPayload = Record<string, unknown>;

export type NewJob = {
    readonly queue: string;
    readonly payload: JobPayload;
    readonly priority?: number;
    /** Defaults to now. */
    readonly runAt?: Date;
    readonly maxAttempts?: number;
    /** While a job with this key is queued, enqueueing another with the same key does nothing. */
    readonly dedupeKey?: string;
};

/**
 * Adds a job inside the caller's unit of work, so it exists exactly when the change that caused
 * it commits. Returns its id, or `undefined` when its dedupe key is already queued.
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
            last_error: null,
            created_at: now,
        })
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .returning("id")
        .executeTakeFirst();
    return inserted?.id;
};
