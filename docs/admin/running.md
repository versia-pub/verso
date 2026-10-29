# Running an instance

How to look after a Verso instance once it is installed: upgrades, scaling, backups, failed jobs and
logs.

## Upgrading

1. Install the new version.
2. Run [`verso migrate`](commands.md#migrating).
3. Restart every `verso serve`, `verso work` and `verso all` process.

On NixOS, the service runs `verso migrate` before it starts, so switching to the new configuration
is enough.

Verso is in early development, and migrations only go forward: back up the database before
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

- **Use PostgreSQL.** Processes share jobs through the database, and tell each other what changed
  through it, such as a new status for streaming clients. SQLite can't, so it suits one process.
- **Share [rate limits](configuring.md#rate-limits)** between web nodes, with `store = "database"`.
- **Use S3 for media**, or a directory every process can reach.
- **Any web node takes streaming clients.** The load balancer must pass WebSocket upgrades.
- **Add workers** when jobs fall behind: each sends more to each remote instance at once.

## Backing up

Back up these, together:

- **The database**, with `pg_dump`, or by copying the SQLite file while Verso is stopped. It holds
  everything users made, and the instance's key pairs. Without the keys, other instances can't trust
  what Verso sends, and push subscriptions stop working. If a key may have leaked, replace it with
  [`verso admin keys rotate`](commands.md#verso-admin-keys).
- **Media**: the `[media] storage` directory, or the S3 bucket.
- **The config**, and the secrets it reads.

## Failed jobs

Work such as deliveries to other instances runs as jobs, which are retried when they fail. A job
that fails for good is kept for `[jobs] dead_letter_days`, 30 by default, so you can see what went
wrong. To list them:

```sql
SELECT queue, last_error, run_at AS died_at, payload
FROM jobs
WHERE finished_at IS NULL AND attempts >= max_attempts
ORDER BY run_at DESC;
```

To run one again once the cause is fixed, give it its attempts back. On PostgreSQL:

```sql
UPDATE jobs SET attempts = 0, run_at = now() WHERE id = '…';
```

Many failed deliveries to one instance usually mean it is down, or blocks yours. Deliveries to an
instance are given up on after `[federation] delivery_hours`, 48 by default.

## Logs

Verso logs to the console at `[logging] level`, `info` by default. In a terminal, logs are in
colour, so the important parts stand out. Elsewhere, such as in journald or container logs, they are
plain text. `NO_COLOR` turns colour off.

Each part of Verso logs under its own name, such as `verso.federation` or `verso.streaming`.

## Health checks

`GET /health/live` answers `ok` while the process is up, for load balancers and container health
checks. `GET /api/v1/streaming/health` answers `OK` too, as on Mastodon.
