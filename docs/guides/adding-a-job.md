# Adding a job

A job is work that runs later, in a worker, and is retried if it fails: anything slow, anything that
calls another server, or anything too large for one transaction. This walks through the `notify`
jobs in [`app/notifications/notifications.ts`](../../app/notifications/notifications.ts), which
notify a status's author's followers 100 at a time. Read
[Events, jobs and messages](../events-and-jobs.md#jobs) first.

```
subscriber, in the transaction        worker, later
  enqueueAll(notify jobs) ──────────►   notifyHandler(ctx, job)
                                          parse the payload
                                          ctx.transaction(…): notify each user
```

## 1. Name the queue and its payload

In the module the work belongs to:

```ts
export const notifyQueue = "notify";

/** Some of the local users a job notifies of a status, and of what. */
export const NotifyJob = z.object({
    type: z.enum(["status", "update"]),
    noteId: z.string(),
    accountIds: z.array(z.string()),
});
```

- **Carry ids (not rows)**, so the job sees what is true when it runs, not when it was queued.
- **Keep the payload small.** Split large work into several jobs, as `notify` jobs carry 100 users
  each.
- **Changing a payload's shape** must still parse jobs queued by the old version, since they may be
  waiting when you upgrade. Add optional fields, rather than renaming or removing them.

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

- **A payload that doesn't parse** can never succeed: throw `PermanentFailure`.
- **It may run twice**, if a worker dies mid-run, so make it idempotent.
- **What it is about may be gone**, such as a deleted status. Do nothing then.
- **Open a transaction to write.** Don't hold one open while calling other servers.
- **Choose how it fails.** Throw to retry after a backoff, `RetryAt` to wait until a time, and
  `PermanentFailure` when retrying can't help.

## 3. Add the queue

Add it to `queues` in [`app/jobs/queues.ts`](../../app/jobs/queues.ts):

```ts
[notifyQueue]: { handler: notifyHandler, concurrency: 2 },
```

- **`concurrency`** is how many of its jobs one worker runs at once: 8 for deliveries, which mostly
  wait on other servers, and 2 for media processing, which uses a lot of memory.
- **`perGroup`** limits the jobs of one group, such as one instance, so one slow server can't take
  every slot. Give each job a `group` when enqueueing it.
- **`leaseMs`**, 5 minutes by default, must be longer than the slowest job, or another worker starts
  it again.
- **`deadPayload`** trims what a dead letter keeps, for payloads that are large.

## 4. Enqueue it

Enqueue jobs in the transaction of the change that causes them, usually from a subscriber, so they
exist exactly when the change commits:

```ts
await enqueueAll(
    ctx,
    batchesOf(accountIds, notifiedPerJob).map((batch) => {
        const payload: z.infer<typeof NotifyJob> = { type, noteId, accountIds: batch };
        return { queue: notifyQueue, payload };
    }),
);
```

Use `enqueue` for one job. A `dedupeKey` stops the same work being queued twice while one is
waiting, and `runAt` delays it. The options are listed in
[Events, jobs and messages](../events-and-jobs.md#jobs).

## Recurring jobs

For work that runs on a schedule, such as a cleanup, add the handler to `hourly` in `queues.ts`. The
scheduler queues it once an hour, in its own queue, and only one runs at a time. For another period,
add a `Task` with `every: "minute"` or `"day"` to `tasks`.

## 5. Test it

Tests have no workers. Run the jobs with `drain`, then check what they did:

```ts
await drain(test.ctx, queues);
```

- **Retries**: make the job fail, then `test.clock.advance` past the backoff and `drain` again.
- **A deleted subject**: delete what the job is about before draining, and check nothing happens.
- **Between instances**, `network.drain()` runs every instance's jobs. See
  [Testing](../testing.md#several-instances).

## Checklist

- [ ] The payload has a Zod schema, carries ids, and old payloads still parse.
- [ ] The handler is idempotent, and does nothing if its subject is gone.
- [ ] It throws `PermanentFailure` only when retrying can't help.
- [ ] The queue is in `queues.ts`, with limits that suit the work.
- [ ] Jobs are enqueued in the transaction of the change that causes them.
- [ ] Tests run it with `drain`, including a retry and a missing subject.
