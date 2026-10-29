# Adding a Versia type

This walks through supporting a new Versia entity type, using reactions, from the
[reactions extension](https://versia.pub/extensions/reactions), as the example. The code is in
[`app/interactions/reaction_federation.ts`](../../app/interactions/reaction_federation.ts). Read
[Federation](../federation.md) first for how entities are received, sent, fetched and served.

```
packages/protocol/v0_6/reactions.ts      the schema, as the spec gives it
app/interactions/reaction_federation.ts  reactionType: receiving, deleting, serving
                                         reactionDeliveries: sending
app/registry.ts                          registers the type and its collections
app/services.ts                          registers the subscriber that sends it
```

## 1. Add the schema

Entity schemas are in [`packages/protocol/v0_6/`](../../packages/protocol/v0_6/), one file per
extension, exported from `mod.ts`. The package has no I/O and knows nothing of Verso, so it holds
only what the spec says:

```ts
/**
 * `author` reacts to the note `object` with `content`: an emoji, a custom emoji's name, or text.
 * @see https://versia.pub/extensions/reactions
 */
export const Reaction = Entity.extend({
    type: z.literal("pub.versia:reactions/Reaction"),
    author: ReferenceText,
    object: ReferenceText,
    content: z.string().min(1),
});
export type Reaction = z.infer<typeof Reaction>;
```

Add tests with the spec's examples. If the spec is unclear, pick a reading, and add it to
[Where the spec is unclear](../federation.md#where-the-spec-is-unclear).

## 2. Store it

Remote entities are usually rows beside local ones, with the sender's `instance_id` and the entity's
`remote_id`, unique together, so receiving the same one twice changes nothing. See
[Adding a table](adding-a-table.md).

## 3. Write the entity type

The `EntityType` says what Verso does with the type. It goes in the module that owns the data, in
its `federation.ts` or a file named for the type:

```ts
export const reactionType: EntityType<v0_6.Reaction> = {
    type: "pub.versia:reactions/Reaction",
    extension: "pub.versia:reactions",
    schema: v0_6.Reaction,
    // Only its author's instance may send it.
    authority: (reaction, origin) => parseReference(reaction.author, origin)?.host,
    prepare: async (ctx, reaction, sender, budget) => {
        // Fetch the author, outside the transaction, if Verso will keep the reaction.
    },
    receive: async (ctx, reaction, sender) => {
        // Look up the author and status, check the author may see it, and keep the reaction.
    },
    deleteRemote: (ctx, id, sender) => undoRemoteReaction(ctx, sender.instanceId, id),
    find: async (ctx, id, requester) => {
        // The local reaction, rendered as Versia JSON, if `requester` may see its status.
    },
};
```

| Field          | Write it so that                                                               |
| -------------- | ------------------------------------------------------------------------------ |
| `authority`    | it names the one instance that may send the entity, usually its author's       |
| `prepare`      | it fetches what `receive` needs with `ctx.federation.resolve`, within `budget` |
| `receive`      | it only looks up what `prepare` fetched, and is idempotent                     |
| `deleteRemote` | a `Delete` of the entity removes it; leave it out if it can't be deleted       |
| `find`         | it returns a local entity only to an instance that may see it                  |
| `known`        | references to the entity can be resolved; only for types others refer to       |

- **Drop what Verso can't show** without failing, as `receive` does for a reaction whose emoji
  Mastodon's clients can't display. Throw `PermanentFailure` for entities that are wrong, which
  tells the sender why.
- **Check what the sender claims.** `authority` stops one instance sending another's entities, but
  `receive` must still check, for example, that the author may see the status they react to.
- **Collections**, such as a status's reactions, are `CollectionProvider`s. Add them to the type
  they belong to in `app/registry.ts`, rather than to that type's module.

## 4. Register it

Add the type to `types` in [`app/registry.ts`](../../app/registry.ts), and its collections to `user`
or `note` there. The registry gives the type to the inbox, the resolver and the entity routes, and
lists its extension in `/.versia/v0.6/instance`. An extension that adds fields but no types goes in
the second list of `createRegistry`.

## 5. Send it

Local changes are sent by an event subscriber that works out the audience and queues a delivery for
each instance:

```ts
export const reactionDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isReactionEvent(event)) return;

    const note = await findNote(ctx, event.noteId);
    if (note === undefined) return;
    const audience = await audienceOfReaction(ctx, event.accountId, note);

    if (event.type === "interactions.reacted") {
        const reaction = await findLocalReaction(ctx, event.reactionId);
        const entity = reaction && await renderVersiaReaction(ctx, reaction);
        if (entity) await queueDeliveriesTo(ctx, entity, audience);
        return;
    }

    const entity = deleteEntity(ctx, event.accountId, typeName, event.reactionId);
    await queueDeliveriesTo(ctx, entity, audience);
};
```

Add it to `subscribers` in [`app/services.ts`](../../app/services.ts). Send only to instances that
may see the entity: [`app/notes/audience.ts`](../../app/notes/audience.ts) has the rules for
statuses.

## 6. Test it

- **Receiving**: post entities to the inbox, from a fake instance, and check what Verso kept. Test
  receiving it twice, a `Delete`, what is dropped and what is refused, as
  `app/interactions/reaction_receive.test.ts` does.
- **Sending and serving**: check who is sent what, and who may fetch it.
- **End to end**: a scenario between instances with `createNetwork`, as in
  `app/interactions/scenarios.test.ts`. See [Testing](../testing.md#several-instances).

## Checklist

- [ ] The schema is in `@versia/protocol`, with the spec's examples as tests.
- [ ] Receiving the same entity twice changes nothing.
- [ ] `authority` names one instance, and `receive` checks what the sender may do.
- [ ] `find` and collections show only what the requester may see.
- [ ] Deliveries go only to instances that may see the entity, and undoing it sends a `Delete`.
- [ ] The type is in `app/registry.ts`, and its subscriber in `app/services.ts`.
- [ ] Spec gaps are listed in `federation.md`.
