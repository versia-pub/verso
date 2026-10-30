# Modules

Each folder in `app/` is a module. Feature modules own their tables: only their own `*_queries.ts`
files write them. See [Architecture](architecture.md) for the rules between modules.

## Feature modules

| Module          | What it does                                 | Start with                    |
| --------------- | -------------------------------------------- | ----------------------------- |
| `accounts`      | accounts, profiles, roles, WebFinger         | `profile.ts`, `roles.ts`      |
| `auth`          | apps, logging in with OpenID Connect, tokens | `authorize.ts`, `tokens.ts`   |
| `notes`         | statuses, who sees them, threads, timelines  | `notes.ts`, `visibility.ts`   |
| `graph`         | follows, blocks, mutes, account notes        | `follows.ts`, `hidden.ts`     |
| `tags`          | hashtags, and those users feature            | `tag_queries.ts`              |
| `interactions`  | likes, boosts and reactions                  | `likes.ts`, `shares.ts`       |
| `emojis`        | custom emojis, local and remote              | `emojis.ts`                   |
| `media`         | uploads, processing, attachments, cleanup    | `uploads.ts`, `processing.ts` |
| `notifications` | notifications, single and grouped            | `notifications.ts`            |
| `push`          | Web Push subscriptions and pushes            | `pushes.ts`                   |
| `streaming`     | the `/api/v1/streaming` WebSocket            | `session.ts`, `dispatcher.ts` |
| `search`        | searching accounts, statuses and hashtags    | `search.ts`                   |
| `markers`       | where a user read up to in a timeline        | `routes.ts`                   |
| `instances`     | this instance, its keys, remote instances    | `keys.ts`, `reachability.ts`  |
| `moderation`    | instances Verso doesn't federate with        | `domain_blocks.ts`            |
| `admin`         | `verso admin …` commands                     | `cli.ts`                      |

Boosts are statuses that point at the status they boost, so they live in `notes`, not in a table of
their own.

## Shared modules

| Module       | What it does                                                                  |
| ------------ | ----------------------------------------------------------------------------- |
| `kernel`     | ports and their adapters, config, settings, events, pubsub, ids, clock, HTML  |
| `db`         | opening the database, migrations, column types, paging, batches, row locks    |
| `http`       | the Hono app, routes, input and responses, OpenAPI, rate limits               |
| `jobs`       | the job queue, worker and scheduler                                           |
| `federation` | the Versia inbox, delivery, the resolver and the entity registry              |
| `testing`    | fakes for tests: a context, a network, an identity provider, S3, an evil peer |

## Who owns which table

| Table                                                                  | Module          |
| ---------------------------------------------------------------------- | --------------- |
| `accounts`, `identities`, `roles`, `account_roles`                     | `accounts`      |
| `apps`, `oauth_flows`, `access_tokens`                                 | `auth`          |
| `notes`, `note_mentions`, `note_tags`, `note_versions`, `note_pins`    | `notes`         |
| `remote_note_totals`, `bookmarks`, `thread_mutes`                      | `notes`         |
| `follows`, `blocks`, `mutes`, `account_domain_blocks`, `account_notes` | `graph`         |
| `endorsements`                                                         | `graph`         |
| `likes`, `reactions`                                                   | `interactions`  |
| `emojis`, `note_emojis`, `account_emojis`                              | `emojis`        |
| `media`, `note_media`                                                  | `media`         |
| `notifications`                                                        | `notifications` |
| `push_subscriptions`, `vapid_keys`                                     | `push`          |
| `note_search`, `account_search`                                        | `search`        |
| `markers`                                                              | `markers`       |
| `tags`, `featured_tags`                                                | `tags`          |
| `instances`, `instance_keys`                                           | `instances`     |
| `domain_blocks`                                                        | `moderation`    |
| `rate_limits`                                                          | `http`          |
| `jobs`, `job_pauses`                                                   | `jobs`          |

Each module's `tables.ts` has the columns, and [`app/db/database.ts`](../app/db/database.ts) lists
every table.

## Packages

| Package              | What it is                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `@versia/protocol`   | Versia 0.6 entities as Zod schemas, references, JSON rules, signing |
| `@versia/client-api` | the Mastodon client API's entities as Zod schemas, and a client     |

Both live in [`packages/`](../packages/) and are imported by name through `deno.json`. The protocol
package imports nothing from `app/` and does no I/O. Verso uses only the client API's schemas, but
its bundle has the client too, about 26 KB: esbuild keeps classes that extend `Error`. A second
entry point, for the schemas alone, made Deno 2.9.7 crash at random while type-checking in the Nix
sandbox. The client's tests run against Verso, in `app/http/client.test.ts`, and
`app/http/client_coverage.test.ts` checks it has a method for every route.
