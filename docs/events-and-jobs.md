# Events, jobs and messages

Three mechanisms carry work beyond the service that started it:

| Mechanism | Runs                                   | For                                        |
| --------- | -------------------------------------- | ------------------------------------------ |
| events    | at once, in the same transaction       | side effects that write rows or queue jobs |
| jobs      | later, in a worker, retried on failure | anything slow, or that calls other servers |
| messages  | after commit, in every process         | telling every process what changed         |

Events are in [`app/kernel/events.ts`](../app/kernel/events.ts), jobs in
[`app/jobs/`](../app/jobs/), and messages in [`app/kernel/pubsub.ts`](../app/kernel/pubsub.ts).

## Events

A service that changes something emits an event inside its transaction. Each module declares its
events in its `events.ts`, as plain data with ids, and a type guard for each:

```ts
/** A local user posted a status. */
export type NotePosted = {
    readonly type: "notes.posted";
    readonly noteId: string;
};

export const isNotePosted = (event: DomainEvent): event is NotePosted =>
    event.type === "notes.posted";
```

`emit(ctx, event)` calls every subscriber in `subscribers`, in
[`app/services.ts`](../app/services.ts), one after the other. A subscriber looks at the event's type
and ignores the ones it doesn't care about:

```ts
export const indexStatuses = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event) || isNoteEdited(event) || isNoteReceived(event)) {
        await indexNotes(ctx, [event.noteId]);
    }
};
```

Rules for subscribers:

- **They run inside the transaction.** If one throws, the whole change rolls back. `emit` throws if
  it isn't in a transaction.
- **They only write rows, queue jobs and publish messages.** A request to another server, or
  anything else slow, goes in a job.
- **Order matters only where a comment says so.** For example, `acceptWhenUnlocked` runs before
  `profileDeliveries`, so a follower it accepts is sent the profile too.
- **A subscriber may emit events of its own.** `notifyOf` emits `notifications.created` for each
  notification it makes, which `queuePushes` hears.

Events carry ids rather than rows, so any module can read them without depending on another module's
row types. A subscriber that needs more looks it up. To add one, see
[Adding a side effect](guides/adding-a-side-effect.md).

## Jobs

A job is a row in the `jobs` table: a queue name, a JSON payload, and when it may run. Enqueue one
with `enqueue` or `enqueueAll` from [`app/jobs/job_queries.ts`](../app/jobs/job_queries.ts), inside
the transaction of the change that caused it. It then exists exactly when the change commits.

```ts
await enqueueAll(
    ctx,
    batchesOf(accountIds, notifiedPerJob).map((batch) => {
        const payload: z.infer<typeof NotifyJob> = { type, noteId, accountIds: batch };
        return { queue: notifyQueue, payload };
    }),
);
```

| Option        | What it does                                                             |
| ------------- | ------------------------------------------------------------------------ |
| `dedupeKey`   | while a job with this key is queued, enqueueing another does nothing     |
| `group`       | puts the job in a group, such as its instance, which the queue can limit |
| `runAt`       | when it may first run; now by default                                    |
| `priority`    | higher runs first among due jobs                                         |
| `maxAttempts` | how many tries before it gives up; 10 by default                         |
| `keepUntil`   | keeps the finished job, and its dedupe key, until then                   |
| `wake`        | wakes idle workers at once on Postgres, rather than at their next poll   |

### Queues

Every queue is listed in [`app/jobs/queues.ts`](../app/jobs/queues.ts), with its handler and limits:

| Field         | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `handler`     | `(ctx, job) => Promise<void>`: runs one job                                  |
| `concurrency` | how many of its jobs one worker runs at once                                 |
| `perGroup`    | how many of one group's jobs one worker runs at once, such as per instance   |
| `leaseMs`     | how long a job may run before another worker may claim it; 5 minutes default |
| `deadPayload` | what a dead job keeps of its payload, such as a summary of a large one       |

Limits are per worker, so three workers send an instance three times as much at once. To add a
queue, see [Adding a job](guides/adding-a-job.md).

### Handlers

```ts
export const notifyHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = NotifyJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a notify job");

    const { type, noteId, accountIds } = payload.data;
    await ctx.transaction(async (tx) => {
        const note = await findNote(tx, noteId);
        if (note === undefined) return;

        await notifyAll(tx, accountIds, type, note.account_id, { noteId });
    });
};
```

- **Validate the payload with Zod.** It was written by a process that may run an older version. A
  payload that doesn't parse can't succeed, so throw `PermanentFailure`.
- **Make handlers idempotent.** A job may run more than once, such as when its worker dies mid-run
  and the lease runs out.
- **Expect what the job is about to be gone.** A status may be deleted before its job runs. Do
  nothing then.
- **Open a transaction if you write.** The handler isn't run in one, so it can make requests without
  holding one open.

### A job's life

```
enqueue ──► queued ──► running ─┬─ resolves ─────────► finished: deleted, or kept until keepUntil
                                ├─ throws ───────────► queued again after a backoff, or a dead
                                │                      letter once out of attempts
                                ├─ RetryAt(date) ────► queued again at that time
                                ├─ PermanentFailure ─► dead letter
                                └─ lease runs out ───► queued again
```

A worker claims a queued job once it is due and its group isn't paused. Claiming leases the job to
the worker and uses one of its attempts.

- **`throw` anything** to retry after a backoff: about 30 seconds, doubling each time up to six
  hours, with jitter. Once its attempts are used up, the job is a dead letter.
- **`throw new RetryAt(date, reason)`** to wait until a time, such as a server's `Retry-After`. It
  doesn't use an attempt.
- **`throw new PermanentFailure(reason)`** when retrying can't help. The job is a dead letter at
  once.
- **Dead letters** stay in the table, with `last_error`, for `[jobs] dead_letter_days`, 30 by
  default, so someone can look at them.
- **Pausing a group.** `postponeGroup(ctx, queue, group, until)` holds every job of a group until a
  time, such as all deliveries to an instance that asked to be left alone. `resumeGroup` ends it.

### Workers and the scheduler

`verso work` and `verso all` run `work` from [`app/jobs/worker.ts`](../app/jobs/worker.ts), which
loops over every queue, claiming jobs as slots free up. On Postgres, `enqueue` sends a `NOTIFY` on
commit, so idle workers start at once; otherwise they poll every second. On stop, a worker claims
nothing more and waits for running jobs to finish.

The scheduler, in [`app/jobs/scheduler.ts`](../app/jobs/scheduler.ts), queues recurring work. The
tasks in `queues.ts` run hourly: cleaning up finished jobs, ended login flows, rate limit counts and
unused media. Every worker runs the scheduler, and a dedupe key per period makes each period's job
exist once.

## Messages between processes

Some things must reach every process, not just one worker: a cache that is stale, or a status that
streaming clients should see. These go through `ctx.pubsub`, with `publish` and `subscribe` from
[`app/kernel/pubsub.ts`](../app/kernel/pubsub.ts). Each kind of message is a `Channel`, with a name
and a Zod schema:

| Channel                 | Says                                        | Heard by               |
| ----------------------- | ------------------------------------------- | ---------------------- |
| `federation.changed`    | the instance key or blocked domains changed | every process's caches |
| `roles.changed`         | an account's roles changed                  | streaming sessions     |
| `tokens.revoked`        | an access token was revoked                 | streaming sessions     |
| `streaming.statuses`    | a status appeared, changed or went          | streaming sessions     |
| `notifications.created` | a notification was made                     | streaming sessions     |

- **`publish` sends after commit**, so no process hears of a change that rolled back. A message is
  at most 7,000 bytes, to fit in a Postgres notification, and `publish` throws on a larger one in
  every adapter, so tests catch it. Messages name ids, not whole rows.
- **Every process hears every message**, the sender included.
- **Messages can be missed**, such as while the listening connection reconnects. `onMissed` runs a
  handler then, so it can reload what it caches.
- **On SQLite**, messages stay in the process that sent them.

## Tests

Tests don't run workers. They call `drain(ctx, queues)` from `app/jobs/worker.ts`, which runs every
due job one at a time, including the jobs those jobs queue, until none are left. With the test
clock, a failed job waits out its backoff, so `drain` always ends. Finished jobs are deleted, so to
check a job ran, check what it did, or that the queue is empty.
