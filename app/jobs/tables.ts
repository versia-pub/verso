/** A row of the jobs table. */
export type JobsTable = {
    id: string;
    queue: string;
    payload: JobPayload;
    /** Higher runs first among jobs that are due. */
    priority: number;
    /**
     * When the job may next run: when enqueued, or after a retry's backoff. For a dead letter, when
     * it died.
     */
    run_at: Date;
    attempts: number;
    /** A job that has used all its attempts is a dead letter, kept for inspection and retry. */
    max_attempts: number;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    dedupe_key: string | null;
    /** Jobs that share one, such as deliveries to one instance, can be limited together. */
    group_key: string | null;
    last_error: string | null;
    created_at: Date;
    /** A finished job is kept until then instead of deleted, so its dedupe key stays taken. */
    keep_until: Date | null;
    /** Set on a finished job that is being kept. */
    finished_at: Date | null;
};

/**
 * A group of a queue's jobs that waits, such as deliveries to an instance that asked to be left
 * alone: none is claimed until it ends.
 */
export type JobPausesTable = {
    queue: string;
    group_key: string;
    until: Date;
};

/** A JSON object, serialised when enqueued, so later changes can't alter a job already queued. */
export type JobPayload = Record<string, unknown>;
