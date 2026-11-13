# Running an instance

How to look after a Verso instance once it's installed.

## Upgrading

Verso is in early development and migrations can't be undone, so back up the database first.

1. Install the new version.
2. Run [`verso migrate`](commands.md#migrating).
3. Restart every `verso serve`, `verso work` and `verso all` process.

On NixOS, the service runs `verso migrate` before it starts, so switching to the new configuration
is enough.

## Scaling

One `verso all` process suits a small instance. To spread the load:

```
      clients and other instances
                  │
            load balancer
         ┌────────┴────────┐
         ▼                 ▼
   verso serve       verso serve      answer requests
         │                 │
         ▼                 ▼
┌──────────────────────────────────┐
│            PostgreSQL            │  rows, jobs, messages between processes
└──────────────────────────────────┘
         ▲                 ▲
         │                 │
   verso work        verso work       deliver, fetch, process media, notify
```

Running more than one process needs PostgreSQL. Processes share jobs through it, and use it to tell
each other what changed, such as a new status for streaming clients. SQLite can't do this.

- Set `store = "database"` for [rate limits](configuring.md#rate-limits), so web nodes share them.
- Store media in S3, or in a directory every process can reach.
- Any web node can take streaming clients, as long as the load balancer passes WebSocket upgrades.
- Add workers when jobs fall behind. Each extra worker also sends more to each remote instance at
  once.

## Backing up

Back these up together:

- the database, with `pg_dump`, or with [`verso admin backup`](commands.md#verso-admin-backup) on
  SQLite;
- media: the `[media] storage` directory, or the S3 bucket;
- the config, and the secrets it reads.

To restore a SQLite copy, stop Verso, delete the database's `-wal` and `-shm` files, and put the
copy in place of the database file.

The database holds the instance's key pairs as well as users' data. Without them, other instances
can't trust what Verso sends, and push subscriptions stop working. If a key may have leaked, replace
it with [`verso admin keys rotate`](commands.md#verso-admin-keys).

## Failed jobs

Work such as delivering to other instances runs as jobs, which are retried when they fail. A job
that fails permanently is kept for `[jobs] dead_letter_days`, 30 by default, so you can see what
went wrong. [`verso admin jobs`](commands.md#verso-admin-jobs) lists them, and once the cause is
fixed, runs them again or deletes them:

```sh
verso admin jobs dead --queue notify
verso admin jobs retry --queue notify
```

Lots of failed deliveries to one instance usually mean it's down, or blocks yours. Deliveries stop
being retried after [`delivery_hours`](configuring.md#federation). Once an instance is back,
[`verso admin domains unpark`](commands.md#verso-admin-domains) sends what is waiting for it.

## Logs

Verso logs to the console at `[logging] level`, `info` by default. In a terminal, logs are pretty:
the time, and the level on a coloured background, so the important parts stand out. Elsewhere, such
as in journald or container logs, they're plain text with the date. With `format = "json"`, they're
one JSON object per line, for log collectors. `NO_COLOR` turns colour off.

Each part of Verso logs under its own category, such as `federation` or `streaming`. JSON logs give
it in full, as `verso.federation`.

At `debug`, each request is logged once answered, under `http.access`, except health checks. Secret
query parameters, such as `access_token`, show as `[FILTERED]`.

Each request has an ID, sent back in `X-Request-Id` and added to every log line written while
handling it. A trusted proxy's `X-Request-Id` is kept, so its logs and Verso's match. Lines from a
job say its `jobId` and `queue`.

## Health checks

`GET /health` returns `OK` while the process is up, for load balancers and container health checks.
Like Mastodon, Verso also has `GET /api/v1/streaming/health`, which returns `OK`.

`GET /health/ready` returns `OK` once the process can serve, or a 503 with what isn't ready:

- `database`: the database didn't answer within 3 seconds.
- `pubsub`: on Postgres, the process doesn't hear the other processes, so what it caches, such as
  blocked domains, may be stale.

The log says why.

## Metrics

With `[metrics] token` set, `GET /metrics` returns OpenMetrics text to a scraper that sends
`Authorization: Bearer <token>`. They come from the database, so every web process gives the same:

| Metric                                 | What it is                                                 |
| -------------------------------------- | ---------------------------------------------------------- |
| `verso_jobs_waiting{queue}`            | Jobs neither finished nor dead, due or not, running or not |
| `verso_jobs_oldest_due_seconds{queue}` | How long the job due longest, not running, has waited      |
| `verso_jobs_dead{queue}`               | Jobs that failed for good, retained                        |
| `verso_instances_parked`               | Instances nothing is sent to until their wait ends         |
| `verso_instances_unreachable`          | Instances that couldn't be reached the last time           |

A growing `verso_jobs_oldest_due_seconds{queue="versia-deliver"}` means deliveries are falling
behind.
