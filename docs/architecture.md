# Architecture

Verso is a [Versia](https://versia.pub) server with a Mastodon-compatible client API. It is a
modular monolith: one Deno program, split into feature modules, that runs as a web node, a job
worker or both. PostgreSQL is the only service it needs. SQLite also works, for small instances and
tests.

## Processes

The same program runs in one of three roles, picked on the command line:

| Command       | Serves HTTP | Runs jobs | Use                               |
| ------------- | ----------- | --------- | --------------------------------- |
| `verso serve` | yes         | no        | web nodes, behind a load balancer |
| `verso work`  | no          | yes       | job workers                       |
| `verso all`   | yes         | yes       | a small instance in one process   |

`verso migrate` brings the database up to date and makes the instance's keys. `verso admin …` runs
admin commands. [`app/main.ts`](../app/main.ts) reads the command line, and
[`app/run.ts`](../app/run.ts) starts each role.

```
   clients                remote instances
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│   verso serve   │     │   verso serve   │  …as many as needed
└────────┬────────┘     └────────┬────────┘
         │  rows and jobs        │
         ▼                       ▼
┌─────────────────────────────────────────┐   ┌─────────────┐
│ PostgreSQL: tables, the jobs queue,     │   │ file store: │
│ LISTEN/NOTIFY between processes         │   │ disk or S3  │
└─────────────────────────────────────────┘   └─────────────┘
         ▲  claim jobs           ▲
         │                       │
┌────────┴────────┐     ┌────────┴────────┐
│    verso work   │     │    verso work   │  send to remote instances,
└─────────────────┘     └─────────────────┘  process media, push
```

Processes share nothing but the database and the file store. They tell each other things, such as
"this cache is stale" or "this status appeared", through Postgres `NOTIFY`. SQLite has no `NOTIFY`,
so there each process hears only its own messages, and workers poll for jobs instead of being woken.
SQLite suits one process running `verso all`.

## Repository layout

```
app/                 the server
  main.ts            command line
  run.ts             builds the context and starts each role
  registry.ts        every Versia entity type Verso supports
  services.ts        event subscribers and the ports modules provide to each other
  kernel/            ports and small shared pieces: config, clock, ids, events, pubsub, …
  db/                Kysely setup, migrations, paging, batches, locking
  http/              Hono app, route definitions, input, responses, OpenAPI, rate limits
  jobs/              the job queue, worker and scheduler
  federation/        Versia inbox, delivery, resolver and entity registry
  accounts/ notes/ graph/ …   feature modules
  testing/           fakes and helpers for tests
packages/
  protocol/          @versia/protocol: Versia entities, references, signing. No I/O.
  client-api/        @versia/client-api: Mastodon API entities as Zod schemas, and a client
lint/plugin.ts       Verso's own lint rules
scripts/             import-cycle and unused-dependency checks, the README banner
nix/                 package, container image, NixOS module, checks, dev shell
docs/                these docs and config.example.toml
```

The [module table](modules.md) lists every feature module, the tables it owns and where to start
reading it.

## Layers

```
HTTP routes (routes.ts)        federation.ts / versia.ts       job handlers
Mastodon API in and out        Versia entities in and out      run what was queued
           │                              │                          │
           └──────────────┬───────────────┴──────────────────────────┘
                          ▼
               services: the module's rules
               plain functions (ctx, input) → result
                          │
           ┌──────────────┼──────────────────────┐
           ▼              ▼                      ▼
     *_queries.ts     other modules'        kernel ports
     (Kysely)         functions             (ctx.files, ctx.transport, …)
           │
           ▼
       database
```

- **Routes and federation code translate.** A route reads the request, calls a service and renders
  the result. `federation.ts` and `versia.ts` turn Versia entities into service calls and rows into
  entities. Neither holds rules of its own.
- **Services hold the rules.** They are plain functions that take a `Context` first, and return
  plain data. They never import Hono or call `fetch`: they talk to the outside through ports.
- **Only `*_queries.ts` files use Kysely.** Query functions are named for what they do, such as
  `findLocalAccount` or `rolesOf`. There is no generic "find where" helper, so a caller can't leave
  out a condition such as who may see a row.
- **A module writes only its own tables.** Other modules call its functions. A query may read
  another module's table when that saves a query, and its comment says which ones it reads. Search
  is the main example: it is a read model over statuses, accounts and the follow graph.
- **`packages/protocol` imports nothing from `app/` and does no I/O**, so it can be tested and
  published on its own.
- **No import cycles.** `deno task import-cycles` checks this, and so does CI.

## A module's files

Most modules split their code the same way. Small modules may merge some of these.

| File                              | Holds                                                   |
| --------------------------------- | ------------------------------------------------------- |
| `tables.ts`                       | Kysely types of the module's tables                     |
| `*_queries.ts`                    | every query on those tables                             |
| `<name>.ts`, such as `follows.ts` | the services: the rules                                 |
| `events.ts`                       | the events the module emits                             |
| `routes.ts`, `*_routes.ts`        | client API routes                                       |
| `render.ts`                       | rows as client API entities                             |
| `federation.ts`, `versia.ts`      | rows as Versia entities, and what remote instances send |
| `*.test.ts`                       | tests, next to the code they test                       |

Migrations aren't in modules: they are all in [`app/db/migrations/`](../app/db/migrations/), in
order, and [`app/db/database.ts`](../app/db/database.ts) lists every table.

## The context and its ports

Every service takes a `Context` as its first argument, defined in
[`app/kernel/context.ts`](../app/kernel/context.ts). It carries everything that touches the outside
world, so tests can swap any of it for a fake:

| Field               | What it is                                | Adapters                     |
| ------------------- | ----------------------------------------- | ---------------------------- |
| `db`                | Kysely, or the current transaction        | Postgres, PGlite, SQLite     |
| `clock`             | the time; nothing calls `Date.now()`      | system clock, test clock     |
| `ids`               | new UUIDv7 ids                            |                              |
| `urls`              | every public URL Verso hands out          |                              |
| `transport`         | HTTP requests to other servers            | `fetch`, a test network      |
| `files`             | where uploaded files are kept             | disk, S3                     |
| `images`            | resizing and cleaning images              | the `vips` CLI               |
| `identityProviders` | OpenID Connect issuers to log in with     | OIDC, development login      |
| `federation`        | keys, blocked domains and the resolver    |                              |
| `pubsub`            | messages between processes                | Postgres `NOTIFY`, in memory |
| `settings`          | what config tells services, computed once |                              |
| `subscribers`       | who hears each event                      |                              |

`contextFor` in [`app/run.ts`](../app/run.ts) is the only place that picks adapters. No module reads
config or environment variables itself.

Two files wire the modules together, so modules don't import each other just to plug in:

- [`app/registry.ts`](../app/registry.ts) lists the Versia entity types, with the collections each
  module adds to users and notes.
- [`app/services.ts`](../app/services.ts) lists the event subscribers, in order, and the services
  the HTTP app and federation need from modules.

## Transactions, events and jobs

A change and everything it causes commit together, or not at all:

```
POST /api/v1/statuses
  │
  ▼
ctx.transaction(tx ⇒ …)  ─────────────────────────────────────────────┐
  │  insert the status (notes/note_queries.ts)                        │
  │  emit(tx, { type: "notes.posted", … })                            │
  │    └─ each subscriber in services.ts, in turn:                    │
  │         noteDeliveries   enqueue a delivery job per instance      │  one database
  │         notifyOf         insert notifications of mentions,        │  transaction
  │                          enqueue jobs to notify followers         │
  │                          emit an event for each notification:     │
  │                            queuePushes  enqueue push jobs         │
  │         streamStatuses   publish "status appeared"                │
  │         indexStatuses    write the status's words for search      │
  ▼                                                                   │
commit ───────────────────────────────────────────────────────────────┘
  │
  ├─ afterCommit: published messages go out to every process
  └─ workers wake and claism the new jobs
```

- **`ctx.transaction`** runs its callback in one database transaction. A nested call joins the outer
  one.
- **`emit`** in [`app/kernel/events.ts`](../app/kernel/events.ts) calls every subscriber with the
  event. It throws outside a transaction, so a job can't be enqueued without the change that caused
  it, or outlive a rollback.
- **Subscribers only write rows and enqueue jobs.** Anything slow, such as a request to another
  server, happens in a job. A new side effect is a new subscriber, not an edit to the service.
- **`ctx.afterCommit`** runs once the transaction commits. `publish` uses it, so other processes
  only hear of what committed.

Jobs live in the `jobs` table. Each queue in [`app/jobs/queues.ts`](../app/jobs/queues.ts) has a
handler and limits on how many of its jobs run at once, in all and per group, such as per remote
instance.

## Ids, references and URLs

- Every row's primary key is a UUIDv7 from `ctx.ids`. They sort by time, so they double as paging
  cursors.
- Remote accounts, statuses and the rest share tables with local ones. `instance_id` is `null` for
  local rows. Remote rows also keep `remote_id`, their id on their instance.
- A Versia reference is computed only when sending: a local row's is its `id`, and a remote row's is
  `domain:remote_id`. No row stores a URL or a full reference, so renaming the instance's domain
  rewrites no rows.
- Every public URL, such as an account's `url` or a media file's, comes from `ctx.urls`.
