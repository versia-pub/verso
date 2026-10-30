# Adding a Versia type

This guide adds support for a new Versia entity type, using the reactions from the
[reactions extension](https://versia.pub/extensions/reactions). The code is in
[`app/interactions/reaction_federation.ts`](../../app/interactions/reaction_federation.ts). Read
[Federation](../federation.md) first.

```
packages/protocol/v0_6/reactions.ts      the schema, as the spec gives it
app/interactions/reaction_federation.ts  reactionType: receiving, deleting, serving
                                         reactionDeliveries: sending
app/registry.ts                          registers the type and its collections
app/services.ts                          registers the subscriber that sends it
```

## 1. Add the schema

Entity schemas are in [`packages/protocol/v0_6/`](../../packages/protocol/v0_6/), one file per
extension, exported from `mod.ts`. The package knows nothing about Verso, so it only holds what the
spec says:

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

Add tests using the spec's examples. If the spec is unclear, pick a reading and add it to
[Where the spec is unclear](../federation.md#where-the-spec-is-unclear).

## 2. Store it

Remote entities are usually stored in the same table as local ones, with the sender's `instance_id`
and the entity's `remote_id`. Make the pair unique, so receiving the same entity twice changes
nothing. See [Adding a table](adding-a-table.md).

## 3. Write the entity type

The `EntityType` says what Verso does with the type. It goes in the module that owns the data, in
its `federation.ts` or a file named after the type:

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

If Verso can't show an entity, drop it quietly, as `receive` does for a reaction with an emoji
Mastodon apps can't display. If an entity is invalid, throw `PermanentFailure`, which tells the
sender why.

`authority` stops an instance from sending another's entities, but `receive` still has to check the
rest. For example, it checks that the author can see the status they're reacting to.

Collections, such as a status's reactions, are `CollectionProvider`s. Add them to the type they
belong to in `app/registry.ts`, not in that type's module.

## 4. Register it

Add the type to `types` in [`app/registry.ts`](../../app/registry.ts), and its collections to `user`
or `note` there. That makes it available to the inbox, the resolver and the entity routes, and lists
its extension in the instance metadata. An extension that only adds fields, with no types, goes in
the second list of `createRegistry`.

## 5. Send it

Local changes are sent by an event subscriber, which works out the audience and queues a delivery to
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

Add it to `subscribers` in [`app/services.ts`](../../app/services.ts). Only send to instances that
may see the entity. [`app/notes/audience.ts`](../../app/notes/audience.ts) has the rules for
statuses.

## 6. Test it

For receiving, post entities to the inbox from a fake instance and check what Verso kept. Cover
receiving the same entity twice, a `Delete`, and what gets dropped or refused, as
`app/interactions/reaction_receive.test.ts` does.

For sending and serving, check who gets sent what, and who can fetch it. Then write an end-to-end
scenario between instances with `createNetwork`, as in `app/interactions/scenarios.test.ts`. See
[Testing](../testing.md#several-instances).

## Checklist

- [ ] The schema is in `@versia/protocol`, with the spec's examples as tests.
- [ ] Receiving the same entity twice changes nothing.
- [ ] `authority` names one instance, and `receive` checks what the sender may do.
- [ ] `find` and collections show only what the requester may see.
- [ ] Deliveries go only to instances that may see the entity, and undoing it sends a `Delete`.
- [ ] The type is in `app/registry.ts`, and its subscriber in `app/services.ts`.
- [ ] Spec gaps are listed in `federation.md`.
