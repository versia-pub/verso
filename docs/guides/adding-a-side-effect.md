# Adding a side effect

A side effect is what one module does when another changes something: sending a reaction to remote
instances, notifying a status's author, indexing a status for search. Modules don't call each other
for these. The module that changes something emits an event, and the others subscribe to it. Read
[Events, jobs and messages](../events-and-jobs.md) first.

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

This walks through the reaction events in [`app/interactions/`](../../app/interactions/).

## 1. Find or declare the event

Look in the changing module's `events.ts` first: the event may already exist. If not, declare it
there, as plain data with ids, and a type guard:

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

- **Name it `<module>.<what happened>`**, in the past tense.
- **Carry ids (not rows)** A subscriber looks up what it needs, so no module depends on another's
  row types.
- **Keep remote and local apart** when subscribers treat them differently. A remote user's reaction
  is `InteractionReceived`, so `reactionDeliveries` can't send it back out by mistake.

## 2. Emit it

Emit it inside the transaction that makes the change, once the change is written:

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

`emit` throws outside a transaction, so a side effect can never commit without its change, or the
change without it.

## 3. Write the subscriber

A subscriber is `(ctx, event) => Promise<void>`, in the module whose effect it is. It ignores events
it doesn't care about:

```ts
/** Indexes statuses as they are posted, edited or received. */
export const indexStatuses = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event) || isNoteEdited(event) || isNoteReceived(event)) {
        await indexNotes(ctx, [event.noteId]);
    }
};
```

It runs in the transaction, so it can do only three kinds of thing:

| To                                             | Do                                          |
| ---------------------------------------------- | ------------------------------------------- |
| change rows                                    | write them, with the module's queries       |
| do anything slow, or that calls another server | enqueue a job, as `reactionDeliveries` does |
| tell every process, such as streaming clients  | `publish`, as `streamStatuses` does         |

If it throws, the whole change rolls back, so it must not fail for reasons the change can't help. A
subscriber may emit events of its own, as `notifyOf` emits `notifications.created`.

## 4. Register it

Add it to `subscribers` in [`app/services.ts`](../../app/services.ts). Subscribers run in that
order. If yours must run before or after another, put it there and say why in a comment, as for
`acceptWhenUnlocked`.

## 5. Test it

Test the effect through the change that causes it: react through the route, then check the
notification exists, or that a delivery was queued. Tests use every subscriber, as the server does.
To test one alone, pass `createTestContext({ subscribers: [yours] })`. If the subscriber enqueues
jobs, run them with `drain`. See [Testing](../testing.md).

## Checklist

- [ ] The event is in the changing module's `events.ts`, with ids, not rows.
- [ ] It is emitted inside the transaction, after the change.
- [ ] The subscriber is in the module whose effect it is, and only writes, enqueues or publishes.
- [ ] It is in `subscribers`, with a comment if its order matters.
- [ ] A test shows the effect happens through the change that causes it.
