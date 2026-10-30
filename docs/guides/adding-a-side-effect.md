# Adding a side effect

A side effect is something one module does when another changes something, such as sending a
reaction to remote instances, notifying a status's author, or indexing a status for search. Modules
don't call each other for these. Instead, the module making the change emits an event, and the
others subscribe to it. Read [Events, jobs and messages](../events-and-jobs.md) first.

```
react(…), in reactions.ts
  ctx.transaction(tx ⇒
    insert the reaction
    emit(tx, interactions.reacted)
      │
      ▼  every subscriber in services.ts, in order
      ├─ reactionDeliveries  queues a delivery to each instance that should get it
      ├─ notifyOf            notifies the status's author
      │    └─ emit(tx, notifications.created)
      │         └─ queuePushes   queues a push to each of the author's subscriptions
      └─ …the rest ignore it
  )
```

This guide uses the reaction events in [`app/interactions/`](../../app/interactions/).

## 1. Find or declare the event

Check the changing module's `events.ts` first, as the event may already exist. If not, declare it
there, with a type guard:

```ts
/** A local user reacted to a status, or undid it. */
export type ReactionEvent = {
    readonly type: "interactions.reacted" | "interactions.unreacted";
    readonly reactionId: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isReactionEvent = (event: DomainEvent): event is ReactionEvent =>
    event.type === "interactions.reacted" || event.type === "interactions.unreacted";
```

Name it `<module>.<what happened>`, in the past tense, and give it ids rather than rows. If
subscribers treat local and remote changes differently, use separate events. A remote user's
reaction is `InteractionReceived`, so `reactionDeliveries` can't send it back out by mistake.

## 2. Emit it

Emit the event inside the transaction that makes the change, after the change is written:

```ts
ctx.transaction(async (tx) => {
    // …
    const removed = emoji && await deleteReaction(tx, accountId, reacted, emoji);
    // …
    const event: ReactionEvent = {
        type: "interactions.unreacted",
        reactionId: removed.id,
        accountId,
        noteId: reacted,
    };
    await emit(tx, event);
    // …
});
```

`emit` throws outside a transaction, so a change and its side effects always commit together.

## 3. Write the subscriber

A subscriber is a function `(ctx, event) => Promise<void>` in the module the effect belongs to. It
ignores events it doesn't care about, as `indexStatuses` in [Events](../events-and-jobs.md#events)
shows. Because it runs inside the transaction, it can only do three kinds of thing:

| To                                             | Do                                          |
| ---------------------------------------------- | ------------------------------------------- |
| change rows                                    | write them, with the module's queries       |
| do anything slow, or that calls another server | enqueue a job, as `reactionDeliveries` does |
| tell every process, such as streaming clients  | `publish`, as `streamStatuses` does         |

If it throws, the whole change rolls back, so it shouldn't fail for reasons that have nothing to do
with the change.

## 4. Register it

Add it to `subscribers` in [`app/services.ts`](../../app/services.ts). Subscribers run in that
order, so if yours has to run before or after another, put it there and say why in a comment, as for
`acceptWhenUnlocked`.

## 5. Test it

Test the effect through the change that causes it. For example, react through the route, then check
that the notification exists or that a delivery was queued. Tests use every subscriber, like the
server does. To test one on its own, pass `createTestContext({ subscribers: [yours] })`. If the
subscriber enqueues jobs, run them with `drain`. See [Testing](../testing.md).

## Checklist

- [ ] The event is in the changing module's `events.ts`, with ids, not rows.
- [ ] It is emitted inside the transaction, after the change.
- [ ] The subscriber is in the module whose effect it is, and only writes, enqueues or publishes.
- [ ] It is in `subscribers`, with a comment if its order matters.
- [ ] A test shows the effect happens through the change that causes it.
