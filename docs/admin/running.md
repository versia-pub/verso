# Running an instance

How to look after a Verso instance once it's installed.

## Upgrading

1. Install the new version.
2. Run [`verso migrate`](commands.md#migrating).
3. Restart every `verso serve`, `verso work` and `verso all` process.

On NixOS, the service runs `verso migrate` before it starts, so switching to the new configuration
is enough.

Verso is in early development and migrations can't be undone, so back up the database before
upgrading.

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

- the database, with `pg_dump`, or by copying the SQLite file while Verso is stopped;
- media: the `[media] storage` directory, or the S3 bucket;
- the config, and the secrets it reads.

The database holds the instance's key pairs as well as users' data. Without them, other instances
can't trust what Verso sends, and push subscriptions stop working. If a key may have leaked, replace
it with [`verso admin keys rotate`](commands.md#verso-admin-keys).

## Failed jobs

Work such as delivering to other instances runs as jobs, which are retried when they fail. A job
that fails permanently is kept for `[jobs] dead_letter_days`, 30 by default, so you can see what
went wrong. To list them:

```sql
SELECT queue, last_error, run_at AS died_at, payload
FROM jobs
WHERE finished_at IS NULL AND attempts >= max_attempts
ORDER BY run_at DESC;
```

Once the cause is fixed, you can run a job again by resetting its attempts. On PostgreSQL:

```sql
UPDATE jobs SET attempts = 0, run_at = now() WHERE id = '…';
```

Lots of failed deliveries to one instance usually mean it's down, or blocks yours. Deliveries stop
being retried after `[federation] delivery_hours`, 48 by default.

## Logs

Verso logs to the console at `[logging] level`, `info` by default. In a terminal, logs are coloured
so the important parts stand out. Elsewhere, such as in journald or container logs, they're plain
text. `NO_COLOR` turns colour off.

Each part of Verso logs under its own category, such as `verso.federation` or `verso.streaming`.

## Health checks

`GET /health/live` returns `ok` while the process is up, for load balancers and container health
checks. Like Mastodon, Verso also has `GET /api/v1/streaming/health`, which returns `OK`.
