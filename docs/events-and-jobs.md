# Events, jobs and messages

Work that goes beyond the service that started it is carried in one of three ways:

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

Subscribers run inside the transaction, so if one throws, the whole change rolls back. `emit` throws
when it's called outside a transaction.

A subscriber only writes rows, queues jobs and publishes messages. Requests to other servers, and
anything else slow, go in a job.

The order of subscribers only matters where a comment says so. For example, `acceptWhenUnlocked`
runs before `profileDeliveries`, so a follower it accepts gets the profile too.

Subscribers can emit events of their own. `notifyOf` emits `notifications.created` for each
notification it makes, and `queuePushes` handles those.

Events carry ids, not rows, so modules don't depend on each other's row types. A subscriber that
needs more looks it up. To add one, see [Adding a side effect](guides/adding-a-side-effect.md).

## Jobs

A job is a row in the `jobs` table: a queue name, a JSON payload, and when it may run. Enqueue one
with `enqueue` or `enqueueAll` from [`app/jobs/job_queries.ts`](../app/jobs/job_queries.ts), inside
the same transaction as the change that caused it, so the job exists only if the change commits.

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

Validate the payload with Zod, since it may have been written by an older version of Verso. A
payload that doesn't parse will never succeed, so throw `PermanentFailure`.

Handlers must be idempotent. A job can run more than once, for example when its worker dies and the
lease runs out.

What the job is about may be gone by the time it runs, such as a deleted status. In that case, do
nothing.

Handlers don't run in a transaction, so they can make requests without holding one open. Open one
yourself to write.

### A job's life

```
enqueue ──► queued ──► running ─┬─ resolves ─────────► finished: deleted, or kept until keepUntil
                                ├─ throws ───────────► queued again after a backoff, or a dead
                                │                      letter once out of attempts
                                ├─ RetryAt(date) ────► queued again at that time
                                ├─ PermanentFailure ─► dead letter
                                └─ lease runs out ───► queued again
```

A worker claims a job once it's due and its group isn't paused. Claiming leases the job to the
worker and uses up one attempt.

- Throwing any error retries the job after a backoff of up to 30 seconds, doubling each time to at
  most six hours, with jitter. When it runs out of attempts, it becomes a dead letter.
- `throw new RetryAt(date, reason)` retries at a given time, such as a server's `Retry-After`,
  without using an attempt.
- `throw new PermanentFailure(reason)` makes it a dead letter straight away, for when retrying can't
  help.

Dead letters stay in the table with their `last_error` for `[jobs] dead_letter_days`, 30 by default,
so someone can look into them.

`postponeGroup(ctx, queue, group, until)` pauses every job in a group until a given time, such as
all deliveries to an instance that asked Verso to slow down. `resumeGroup` ends the pause.

### Workers and the scheduler

`verso work` and `verso all` run `work` from [`app/jobs/worker.ts`](../app/jobs/worker.ts), which
loops over every queue and claims jobs as slots free up. On Postgres, `enqueue` sends a `NOTIFY` on
commit, so idle workers start straight away. Otherwise they poll every second. When stopped, a
worker stops claiming jobs and waits for running ones to finish.

The scheduler, in [`app/jobs/scheduler.ts`](../app/jobs/scheduler.ts), queues recurring work. The
tasks in `queues.ts` run hourly: cleaning up finished jobs, ended login flows, rate limit counts and
unused media. Every worker runs the scheduler, and a dedupe key per period makes sure each task is
queued once per period.

## Messages between processes

Some things need to reach every process, not just one worker, such as a stale cache or a status that
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

`publish` sends after commit, so no process hears about a change that rolled back. Every process
gets every message, including the one that sent it. On SQLite, messages stay in the process that
sent them.

A message can be at most 7,000 bytes, to fit in a Postgres notification. Every adapter throws on a
larger one, so tests catch it. Messages carry ids, not whole rows.

Messages can be missed, for example while the listening connection reconnects. `onMissed` registers
a handler for that, so it can reload what it caches.

## Tests

Tests don't run workers. They call `drain(ctx, queues)` from `app/jobs/worker.ts`, which runs every
due job one at a time, including the jobs those jobs queue, until none are left. With the test
clock, a failed job waits out its backoff, so `drain` always ends. Finished jobs are deleted, so to
check that a job ran, check what it did, or that its queue is empty.
