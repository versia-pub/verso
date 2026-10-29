# Verso's documentation

These docs explain how Verso works and how to change it. To set up and run Verso, start with
[CONTRIBUTING.md](../CONTRIBUTING.md).

- [Architecture](architecture.md): processes, layers, the context, events and jobs
- [Modules](modules.md): every module, the tables it owns, and where to start reading it
- [Database](database.md): Kysely, writing queries, Postgres and SQLite, migrations
- [HTTP](http.md): routes, what happens to a request, input, responses, errors, auth, OpenAPI
- [Events, jobs and messages](events-and-jobs.md): subscribers, the job queue, workers, pubsub
- [Federation](federation.md): Versia receiving, sending, fetching, signatures, spec gaps
- [Logging in and permissions](auth.md): apps, OpenID Connect, tokens, scopes, roles
- [Media](media.md): uploads, image processing with vips, file stores, cleanup
- [Notifications and push](notifications.md): who is notified, grouped notifications, markers, Web
  Push
- [Streaming](streaming.md): the WebSocket, streams, the dispatcher, limits
- [Search](search.md): indexing words, status queries, accounts, hashtags, limits

[`config.example.toml`](config.example.toml) lists every config setting, with its default.
