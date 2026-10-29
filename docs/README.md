# Verso's documentation

These docs explain how to run Verso, how it works and how to change it. To work on Verso itself,
start with [CONTRIBUTING.md](../CONTRIBUTING.md).

## Running Verso

- [Installing](admin/installing.md): NixOS, the container image, the package, a reverse proxy
- [Configuring](admin/configuring.md): the instance, logging in, permissions, media, federation
- [Commands](admin/commands.md): running, migrating, and the admin commands
- [Running an instance](admin/running.md): upgrading, scaling, backups, failed jobs, logs
- [Moderating](admin/moderating.md): blocking instances, moderators, custom emoji

## Using the API

- [Mastodon API compatibility](api/compatibility.md): every Mastodon 4.3 method with Verso's
  differences

## How Verso works

- [Architecture](architecture.md): processes, layers, the context, events and jobs
- [Modules](modules.md): every module, the tables it owns, and where to start reading it
- [Database](database.md): Kysely, writing queries, Postgres and SQLite, migrations
- [HTTP](http.md): routes, what happens to a request, input, responses, errors, auth, OpenAPI
- [Events, jobs and messages](events-and-jobs.md): subscribers, the job queue, workers, pubsub
- [Federation](federation.md): Versia receiving, sending, fetching, signatures, spec gaps
- [Logging in and permissions](auth.md): apps, OpenID Connect, tokens, scopes, roles
- [Media](media.md): uploads, image processing with vips, file stores, cleanup
- [Notifications and push](notifications.md): who is notified, grouping, markers, Web Push
- [Streaming](streaming.md): the WebSocket, streams, the dispatcher, limits
- [Search](search.md): indexing words, status queries, accounts, hashtags, limits
- [Configuration](configuration.md): reading the config, secrets, how settings reach the code
- [Testing](testing.md): test contexts, route tests, several instances, fakes, snapshots
- [Build and CI](build-and-ci.md): Nix outputs, vendored dependencies, the image, checks, CI
- [Maintenance](maintenance.md): dependencies, tools, the Mastodon version, unused code

## How to add things

- [Adding a route](guides/adding-a-route.md)
- [Adding a table](guides/adding-a-table.md)
- [Adding a Versia type](guides/adding-a-versia-type.md)
- [Adding a side effect](guides/adding-a-side-effect.md)
- [Adding a job](guides/adding-a-job.md)
- [Adding a config option](guides/adding-a-config-option.md)

[`config.example.toml`](config.example.toml) lists every config setting, with its default.
