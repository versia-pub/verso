# Federation

Verso federates over [Versia 0.6](https://versia.pub). Instances send each other signed JSON
entities, such as a `User` or a `Note`, over HTTPS. Entities travel in four ways:

```
Receiving   remote ── POST inbox ──► inbox route ── job ──► inbox worker ──► type.receive
Sending     subscriber ── job ──► delivery worker ── POST inbox ──► remote
Fetching    resolver ── GET entity ──► remote ──► type.receive
Serving     remote ── GET entity ──► entity routes ──► type.find
```

- **Receiving.** A remote instance posts an entity to Verso's inbox. Verso checks it, queues it, and
  a worker applies it.
- **Sending.** A local change emits an event. A subscriber queues a delivery job for each instance
  that should get it, and a worker signs and sends it.
- **Fetching.** When Verso meets a reference it doesn't have, such as a reply's parent, the resolver
  fetches it.
- **Serving.** Other instances fetch Verso's entities the same way, from its entity routes.

The code is in [`app/federation/`](../app/federation/), with each module's own entities in its
`federation.ts` or `versia.ts`. Versia's schemas, references and signing are in
[`packages/protocol`](../packages/protocol/), which does no I/O.

## The entity registry

[`app/registry.ts`](../app/registry.ts) lists every entity type Verso supports. Each is an
`EntityType` from [`app/federation/registry.ts`](../app/federation/registry.ts), which the inbox,
the resolver and the entity routes all read:

| Field           | What it does                                                           |
| --------------- | ---------------------------------------------------------------------- |
| `type`          | the name, such as `Note` or `pub.versia:likes/Like`                    |
| `extension`     | the extension that defines it, for an extension's type                 |
| `schema`        | the Zod schema from `@versia/protocol`                                 |
| `authority`     | the only instance that may send it, usually its author's               |
| `prepare`       | fetches what it refers to, outside the transaction                     |
| `receive`       | applies it, in a transaction; must be idempotent                       |
| `deleteRemote`  | deletes it when a `Delete` says so                                     |
| `prepareDelete` | work too big for one transaction, before `deleteRemote`                |
| `known`         | finds what a reference points at, if Verso has it                      |
| `find`          | a local entity, as a remote instance may see it, for the entity routes |
| `collections`   | its collections, such as a user's followers, by name                   |
| `resendable`    | whether the same entity may be sent again on purpose                   |

Modules add collections to `User` and `Note` in `app/registry.ts`, so `notes` doesn't need to know
about likes, nor `accounts` about follows. The registry also lists the extensions Verso supports,
for `/.versia/v0.6/instance`.

## Receiving

```
POST /.versia/v0.6/inbox
  │  signed route: signature checked, sender not blocked, rate limited by instance
  ▼
queueEntity (inbox.ts)
  │  Versia JSON? known type? matches its schema? (an unknown extension type is dropped)
  │  enqueue an inbox job, deduped by sender and body for 10 minutes
  ▼
202 Accepted

  ⋮  later, in a worker

inboxHandler (inbox_worker.ts)
  │  sender blocked since? drop it
  │  check the entity again, in case Verso changed since
  │  authority(entity) is the sender? otherwise give up
  │  type.prepare: fetch what it refers to, up to 20 fetches in 2 minutes
  ▼
ctx.transaction(tx ⇒ type.receive(tx, entity, sender))
```

- The inbox answers 202 once the entity is queued. Anything slow happens in the worker.
- An entity that is invalid, or sent by an instance that may not send it, is given up on with
  `PermanentFailure`, and the sender is told why through instance messaging, if it accepts it.
- The dedupe key stops a replayed request being applied twice. For a `resendable` type, such as a
  user whose profile changed back, the key includes the signature, so only an identical request is a
  duplicate.
- `Delete` is a type of its own, in [`app/federation/delete.ts`](../app/federation/delete.ts). It
  calls the deleted entity's type's `prepareDelete` and `deleteRemote`.

## Sending

A module's subscriber decides who should get an entity, and calls
`queueDeliveriesTo(ctx, entity,
instanceIds)` from
[`app/federation/deliver.ts`](../app/federation/deliver.ts). For example, `noteDeliveries` sends a
new status to the instances of its audience, which
[`app/notes/audience.ts`](../app/notes/audience.ts) works out.

- **One job per instance**, in the `versia-deliver` queue, grouped by domain. The entity is
  serialised once, when queued, so later changes can't alter what is sent.
- **Blocked instances** get nothing. **Unreachable instances**, which haven't answered for
  `[federation] unreachable_days`, get nothing until Verso hears from them again.
- **The worker** signs the body and posts it. A 2xx is done. A 4xx other than 408 and 429 is given
  up on. Anything else is retried for `[federation] delivery_hours`, 48 by default.
- **An instance that asks to wait**, with `Retry-After` or `RateLimit-Remaining: 0`, has its whole
  group of deliveries paused until then.
- **A circuit breaker** in [`app/instances/reachability.ts`](../app/instances/reachability.ts) parks
  an instance that fails too often in a row. Its deliveries wait, and one request at a time probes
  whether it is back. Any request from it, or any answer other than a server error, resumes them.

## Fetching

`ctx.federation.resolve(ctx, reference, type, budget)`, built in
[`app/federation/resolver.ts`](../app/federation/resolver.ts), returns Verso's id for what a
reference points at:

1. A local reference is looked up with the type's `known`.
2. A remote one that Verso has, fetched in the last day, is used as it is.
3. Otherwise, it is fetched from its instance, its signature checked, and stored with `receive`. If
   fetching fails, the stored copy is used, if there is one.

Fetches are limited so remote content can't make Verso fetch without end:

- **A budget** per request or job: by default 20 fetches, shared by every resolve it does, and
  optionally a deadline, after which requests in flight are aborted.
- **A limit per instance**: 600 fetches every 5 minutes from each process, by default, as
  `[federation.fetch_limit]` says.
- **Missing entities** are remembered for an hour, so a reference to one that is gone isn't fetched
  again and again.
- **Blocked instances** are never fetched from.

A process makes one resolver and shares it, so two resolves of the same reference share one fetch.

Remote instances fetch Verso's entities from `/.versia/v0.6/entities/<type>/<id>`, and their
collections from `…/collections/<name>`. `entityRoutes` in `app/federation/registry.ts` makes these
routes from the registry, using each type's `find` and `collections`, which check what the
requesting instance may see. `/.well-known/versia` and `/.versia/v0.6/instance`, which tell peers
the instance's versions and key, are in
[`app/instances/versia_routes.ts`](../app/instances/versia_routes.ts).

## Signatures and keys

Every request between instances, and every response to one, is signed with Ed25519 over the method,
the path, a timestamp and the SHA-256 of the body. `@versia/protocol`'s `signing.ts` signs and
verifies. Verify the body exactly as it arrived: parsing and serialising it again breaks the
signature.

- **This instance's key pair** is made by `verso migrate`, kept in `instance_keys`, and replaced
  with `verso admin keys rotate`. See [`app/instances/keys.ts`](../app/instances/keys.ts).
- **Remote instances' keys** come from their `/.versia/v0.6/instance`, and are kept in `instances`
  and in memory. When a signature fails, the key is fetched again, at most so often, in case the
  instance rotated it. See [`app/instances/remote_keys.ts`](../app/instances/remote_keys.ts).
- **Signed routes** have `signed: true`. The HTTP app checks the signature before anything else,
  gives the handler the signer's domain, and signs the response.
- **Requests Verso sends** go through `sendSigned` in
  [`app/federation/request.ts`](../app/federation/request.ts).

## Blocking instances

Admins block instances with `[federation] blocked_domains` in config, or
`verso admin domains
block`. A blocked domain's subdomains are blocked too. Verso then refuses what
it sends, sends it nothing, and fetches nothing from it. With `silent_blocks`, it answers as if
nothing were wrong, so the instance can't tell. See
[`app/moderation/domain_blocks.ts`](../app/moderation/domain_blocks.ts).

Users' own domain blocks are different: they hide an instance from one user, and live in `graph`.

## Safety

- **No internal addresses.** The transport refuses to connect to private, loopback and link-local
  addresses, after resolving DNS, so remote content can't make Verso call its own network.
  `[federation] allow_internal_addresses` turns this off, for development only.
- **Remote HTML is sanitised** when it is rendered, by
  [`app/kernel/html.ts`](../app/kernel/html.ts). Images and other things that load from elsewhere
  are removed, since Verso doesn't proxy remote media and loading it would reveal readers'
  addresses.
- **Rate limits.** Signed routes are limited per instance, as in [HTTP](http.md#rate-limits).

## Instance messaging

Versia lets instances tell each other, in plain text, why something failed. Verso sends a message
when it gives up on an entity, if the sender supports it, and logs the messages it receives, for
admins to read. See [`app/federation/messaging.ts`](../app/federation/messaging.ts).

## Where the spec is unclear

Where the Versia 0.6 spec is unclear or wrong, Verso does as follows. Each will be raised upstream.

- **[Signing](https://versia.pub/signatures)**: the example code uses milliseconds; the text says
  seconds. Verso uses seconds.
- **The query string isn't signed.** Verso uses it only for paging.
- **The destination host isn't signed**, so a request can be replayed to another instance for 5
  minutes. Nothing can be done without a spec change.
- **Optional fields** must be `null` ([entities](https://versia.pub/entities#entity-definition)), or
  may be left out ([JSON](https://versia.pub/json#optional-fields)). Verso accepts both, and leaves
  unset fields out when sending.
- **`remote` is required**, but the User, InstanceMetadata and Collection examples leave it out.
  Verso requires it.
- **The Note example is invalid JSON**, missing a comma. Verso's tests use a fixed copy.
- **Delete's `author`** is required in its table, and optional in the changelog. Verso takes it as
  optional: missing means the signing instance.
- **`compatibility.versions`** should hold `0.X`, but every example says `0.6.0`. Verso sends
  `0.6.0` and accepts any string.
- **Note `group` keywords** `public` and `followers` are also valid bare ids. Verso treats them as
  the keywords.
- **Rules written in prose**, such as an avatar being `image/*` and attachments being remote. Verso
  enforces them.
- **Domains can't have a port**, but references don't say. Verso lets references have one, for local
  testing.
- **Reference hostnames have no canonical form.** Verso lowercases them, drops port 443, compresses
  IPv6 and uses ASCII only.
- **Extension keys that break the naming rules** are rejected with 422.
- **[JSON](https://versia.pub/json) keys can't have `$` or `+`**, but entities have `$schema`, and
  content formats such as `image/svg+xml`. Verso also allows `+`, and `$` at the start.

## Tests

Federation is tested with complete instances talking to each other in one process.
[`app/testing/network.ts`](../app/testing/network.ts) gives each instance a domain on a fake
network, and `drain` runs every instance's jobs. [`app/testing/evil.ts`](../app/testing/evil.ts) is
an instance that misbehaves on purpose, with bad signatures, rotated keys or unexpected answers.
`nix flake check` also runs `federation-vms`, NixOS VMs that federate over a real network.
