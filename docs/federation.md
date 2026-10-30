# Federation

This is how Verso implements [Versia 0.6](https://versia.pub). This document assumes you know the
spec, and covers only Verso's side of it. Entities move in four ways:

```
Receiving   remote ── POST inbox ──► inbox route ── job ──► inbox worker ──► type.receive
Sending     subscriber ── job ──► delivery worker ── POST inbox ──► remote
Fetching    resolver ── GET entity ──► remote ──► type.receive
Serving     remote ── GET entity ──► entity routes ──► type.find
```

The shared code is in [`app/federation/`](../app/federation/). Each module keeps its own entities in
its `federation.ts` or `versia.ts`. Versia's schemas, references and signing live in
[`packages/protocol`](../packages/protocol/), which does no I/O.

## The entity registry

[`app/registry.ts`](../app/registry.ts) lists every entity type Verso supports. Each one is an
`EntityType` from [`app/federation/registry.ts`](../app/federation/registry.ts), and the inbox, the
resolver and the entity routes all work from it:

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

Modules add their collections to `User` and `Note` in `app/registry.ts`, so `notes` doesn't need to
know about likes, and `accounts` doesn't need to know about follows. The registry also lists the
extensions Verso supports, for `/.versia/v0.6/instance`. To add a type, see
[Adding a Versia type](guides/adding-a-versia-type.md).

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

If an entity is invalid, or comes from an instance that isn't allowed to send it, the job fails with
`PermanentFailure`. Verso then tells the sender why over instance messaging, if the sender supports
it.

The dedupe key stops a replayed request from being applied twice. Some types are `resendable`, such
as a user whose profile changed and then changed back. For those, the key includes the signature, so
only an identical request counts as a duplicate.

`Delete` is handled in [`app/federation/delete.ts`](../app/federation/delete.ts), which calls
`prepareDelete` and `deleteRemote` on the deleted entity's type.

## Sending

Each module's subscribers decide who gets an entity, and pass it to `queueDeliveriesTo` in
[`app/federation/deliver.ts`](../app/federation/deliver.ts) with the instances to send it to. For a
new status, `noteDeliveries` sends it to the instances of its audience, which
[`app/notes/audience.ts`](../app/notes/audience.ts) works out.

Each instance gets its own job in the `versia-deliver` queue, grouped by domain. The entity is
serialised once, when the job is queued, so later changes don't alter what is sent. Nothing is sent
to blocked instances, or to instances that haven't answered for `[federation] unreachable_days`,
until Verso hears from them again.

The worker signs the body and posts it:

- A 2xx answer means it's delivered.
- A 4xx answer, other than 408 and 429, fails the job permanently.
- Anything else is retried for `[federation] delivery_hours`, 48 by default.
- If the instance sends `Retry-After` or `RateLimit-Remaining: 0`, the whole group of deliveries to
  it waits until then.

A circuit breaker in [`app/instances/reachability.ts`](../app/instances/reachability.ts) parks an
instance after 5 failures in a row. Its deliveries wait, and a single request at a time checks
whether it's back. Any request from that instance, or any answer that isn't a server error, resumes
them.

## Fetching

`ctx.federation.resolve(ctx, reference, type, budget)` returns Verso's id for whatever a reference
points at. It's built in [`app/federation/resolver.ts`](../app/federation/resolver.ts):

1. A local reference is looked up with the type's `known`.
2. A remote entity that Verso fetched in the last day is used as it is.
3. Anything else is fetched from its instance, its signature checked, and stored with `receive`. If
   the fetch fails, Verso falls back to the stored copy, if it has one.

Remote content could otherwise make Verso fetch forever, so fetches are limited:

- Each request or job gets a budget, by default 20 fetches shared by all its resolves, and
  optionally a deadline. Requests still in flight at the deadline are aborted.
- Each process makes at most 600 fetches every 5 minutes to any one instance, by default. This is
  `[federation.fetch_limit]`.
- An entity that turned out to be missing is remembered for an hour, so it isn't fetched again and
  again.
- Nothing is fetched from blocked instances.

Each process shares one resolver, so two resolves of the same reference make one fetch.

## Serving

`entityRoutes` in `app/federation/registry.ts` builds the entity and collection routes from the
registry. They use each type's `find` and `collections`, which check what the requesting instance
may see. The discovery and instance metadata routes are in
[`app/instances/versia_routes.ts`](../app/instances/versia_routes.ts).

## Signatures and keys

`signing.ts` in `@versia/protocol` signs and verifies. Always verify the body exactly as it arrived:
parsing it and serialising it again breaks the signature.

`verso migrate` makes the instance's key pair and keeps it in `instance_keys`.
`verso admin keys rotate` replaces it. See [`app/instances/keys.ts`](../app/instances/keys.ts).

Remote instances' keys are kept in `instances`, and in memory. When a signature doesn't verify,
Verso fetches the key again in case the instance rotated it, at most once every 5 minutes per
instance. See [`app/instances/remote_keys.ts`](../app/instances/remote_keys.ts).

For routes with `signed: true`, the HTTP app checks the signature before anything else, passes the
signer's domain to the handler, and signs the response. Requests Verso sends go through `sendSigned`
in [`app/federation/request.ts`](../app/federation/request.ts).

## Blocking instances

Admins block instances in config, with `[federation] blocked_domains`, or with
`verso admin domains block`. Blocking a domain blocks its subdomains too. Verso then refuses
everything the instance sends, sends it nothing, and fetches nothing from it. With `silent_blocks`,
Verso answers as if nothing were wrong, so the instance can't tell it's blocked. See
[`app/moderation/domain_blocks.ts`](../app/moderation/domain_blocks.ts).

Users' own domain blocks are a different thing. They hide an instance from one user, and live in
`graph`.

## Safety

The transport won't connect to private, loopback or link-local addresses, and checks after resolving
DNS. This stops remote content from making Verso call into its own network.
`[federation] allow_internal_addresses` turns the check off, for development only.

Remote HTML is sanitised when it's rendered, by [`app/kernel/html.ts`](../app/kernel/html.ts).
Images and anything else that loads from elsewhere are removed: Verso doesn't proxy remote media,
and loading it would reveal readers' IP addresses.

Signed routes are rate limited per instance, as described in [HTTP](http.md#rate-limits).

## Instance messaging

Verso sends a message when it drops an entity, if the sender supports instance messaging, and logs
the messages it receives for admins to read. See
[`app/federation/messaging.ts`](../app/federation/messaging.ts).

## Where the spec is unclear

Here is what Verso does where the Versia 0.6 spec is unclear or wrong. Each of these will be raised
upstream.

- [Signing](https://versia.pub/signatures): the example code uses milliseconds, but the text says
  seconds. Verso uses seconds.
- The query string isn't signed. Verso only uses it for paging.
- The destination host isn't signed, so a request can be replayed to another instance for 5 minutes.
  This needs a spec change to fix.
- Optional fields must be `null` according to
  [entities](https://versia.pub/entities#entity-definition), but may be left out according to
  [JSON](https://versia.pub/json#optional-fields). Verso accepts both, and leaves unset fields out
  when sending.
- `remote` is required, but the User, InstanceMetadata and Collection examples leave it out. Verso
  requires it.
- The Note example is invalid JSON: it's missing a comma. Verso's tests use a fixed copy.
- Delete's `author` is required in its table, but optional in the changelog. Verso treats it as
  optional, and a missing author means the signing instance.
- `compatibility.versions` should hold `0.X`, but every example says `0.6.0`. Verso sends `0.6.0`
  and accepts any string.
- The Note `group` keywords `public` and `followers` are also valid bare ids. Verso treats them as
  the keywords.
- Some rules are only written in prose, such as avatars being `image/*` and attachments being
  remote. Verso enforces them.
- Domains can't have a port, but the spec doesn't say whether references can. Verso allows a port in
  references, for local testing.
- Reference hostnames have no canonical form. Verso lowercases them, drops port 443, compresses IPv6
  and uses ASCII only.
- Extension keys that break the naming rules are rejected with a 422.
- [JSON](https://versia.pub/json) keys can't contain `$` or `+`, but entities have `$schema`, and
  content types such as `image/svg+xml`. Verso allows `+` anywhere and `$` at the start.

## Tests

Federation tests run complete instances that talk to each other in one process.
[`app/testing/network.ts`](../app/testing/network.ts) gives each instance a domain on a fake
network, and `drain` runs every instance's jobs. [`app/testing/evil.ts`](../app/testing/evil.ts) is
an instance that misbehaves on purpose, with bad signatures, rotated keys or unexpected answers.
`nix flake check` also runs `federation-vms`, which federates NixOS VMs over a real network.
