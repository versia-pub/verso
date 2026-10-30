# Adding a job

Jobs are for work that's slow, calls another server, or is too big for one transaction. They run
later in a worker, and are retried if they fail. This guide uses the `notify` jobs in
[`app/notifications/notifications.ts`](../../app/notifications/notifications.ts), which notify a
status author's followers 100 at a time. Read
[Events, jobs and messages](../events-and-jobs.md#jobs) first.

```
subscriber, in the transaction        worker, later
  enqueueAll(notify jobs) ──────────►   notifyHandler(ctx, job)
                                          parse the payload
                                          ctx.transaction(…): notify each user
```

## 1. Name the queue and its payload

Do this in the module the work belongs to:

```ts
export const notifyQueue = "notify";

/** Some of the local users a job notifies of a status, and of what. */
export const NotifyJob = z.object({
    type: z.enum(["status", "update"]),
    noteId: z.string(),
    accountIds: z.array(z.string()),
});
```

Payloads carry ids, not rows, so the job sees what's true when it runs rather than when it was
queued. Keep them small, and split large work into several jobs, as `notify` does with 100 users
each.

Jobs queued by an older version may still be waiting after an upgrade, so a changed payload schema
must still parse them. Add optional fields instead of renaming or removing fields.

## 2. Write the handler

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

[Handlers](../events-and-jobs.md#handlers) explains the rules this follows: the payload is
validated, the handler is idempotent, it does nothing if the status is gone, and it opens its own
transaction to write. Don't hold a transaction open while calling other servers. To decide how it
fails, see [A job's life](../events-and-jobs.md#a-jobs-life).

## 3. Add the queue

Add it to `queues` in [`app/jobs/queues.ts`](../../app/jobs/queues.ts):

```ts
[notifyQueue]: { handler: notifyHandler, concurrency: 2 },
```

Pick `concurrency` to suit the work. Deliveries, which mostly wait on other servers, run 8 at once
per worker, and media processing, which uses a lot of memory, runs 2. Use `perGroup` so one slow
instance can't take every slot, and give each job a `group` when enqueueing it. `leaseMs`, 5 minutes
by default, must be longer than the slowest job, or another worker will start it again.
[Queues](../events-and-jobs.md#queues) lists every field.

## 4. Enqueue it

Enqueue jobs in the same transaction as the change that causes them, usually from a subscriber, so
they only exist if the change commits:

```ts
await enqueueAll(
    ctx,
    batchesOf(accountIds, notifiedPerJob).map((batch) => {
        const payload: z.infer<typeof NotifyJob> = { type, noteId, accountIds: batch };
        return { queue: notifyQueue, payload };
    }),
);
```

Use `enqueue` for a single job. A `dedupeKey` stops the same work from being queued twice, and
`runAt` delays it. [Jobs](../events-and-jobs.md#jobs) lists every option.

## Recurring jobs

For scheduled work, such as a cleanup, add the handler to `hourly` in `queues.ts`. The scheduler
queues it once an hour in its own queue, one at a time. For a different period, add a `Task` to
`tasks` with `every: "minute"` or `"day"`.

## 5. Test it

Tests have no workers. Run the jobs with `drain`, then check what they did:

```ts
await drain(test.ctx, queues);
```

To test retries, make the job fail, then `test.clock.advance` past the backoff and `drain` again. To
test a missing subject, delete it before draining and check nothing happens. With several instances,
`network.drain()` runs every instance's jobs, as [Testing](../testing.md#several-instances) shows.

## Checklist

- [ ] The payload has a Zod schema, carries ids, and old payloads still parse.
- [ ] The handler is idempotent, and does nothing if its subject is gone.
- [ ] It throws `PermanentFailure` only when retrying can't help.
- [ ] The queue is in `queues.ts`, with limits that suit the work.
- [ ] Jobs are enqueued in the transaction of the change that causes them.
- [ ] Tests run it with `drain`, including a retry and a missing subject.
