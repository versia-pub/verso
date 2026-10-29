# Streaming

Clients open a WebSocket to `/api/v1/streaming` and are sent statuses and notifications as they
happen, as on Mastodon's streaming server. Verso serves it from the same process and port as the
rest of the API, so any `verso serve` or `verso all` process takes streaming clients.

The code is in [`app/streaming/`](../app/streaming/), with each kind of stream in its own file:
`user.ts`, `public.ts` and `hashtags.ts`.

## How a status reaches a client

```
a status is posted, edited, deleted or boosted
  │
  ▼
streamStatuses (subscriber, in the transaction)
  │  publish on streaming.statuses after commit: the status's id, or for a
  │  deleted one, who could have seen it
  ▼
every process hears it
  │
  ▼
dispatcher: one per process, one message at a time
  │
  ├──► user streams      the author and their followers, each rendered as they see it
  ├──► public streams    rendered once, as anyone sees it
  └──► hashtag streams   rendered once, as anyone sees it
         │
         ▼
       each session subscribed to a stream it is on ──► WebSocket
```

- **Messages carry ids, not statuses**, so nothing private travels between processes. Each process
  looks the status up itself, for the sessions it has.
- **Notifications** come the same way, on `notifications.created`, and go only to their user's
  sessions.
- **One subscription per process.** The dispatcher, in
  [`app/streaming/dispatcher.ts`](../app/streaming/dispatcher.ts), subscribes once to each channel,
  rather than once per WebSocket, and hands each message to each kind of stream.
- **In order.** Messages are handled one at a time, so a client never gets a status's delete before
  its update. Publishing doesn't wait for them.
- **Falling behind.** Past 1,000 messages waiting, new ones are dropped and a warning is logged,
  rather than kept in memory.

## Streams

| Stream                                    | Sends                                   |
| ----------------------------------------- | --------------------------------------- |
| `user`                                    | the home timeline, and notifications    |
| `user:notification`                       | notifications only                      |
| `public`, `public:local`, `public:remote` | the public timeline: all, local, remote |
| the same, with `:media`                   | those with media attached               |
| `hashtag`, `hashtag:local`                | public statuses with the hashtag `tag`  |

- **`user`** needs `read:statuses`, and `user:notification` needs `read:notifications`. The `user`
  stream has notifications only if the token may read them, as on Mastodon.
- **Home statuses** are rendered once for each viewer, as they see them, so 8 viewers at a time.
  Public and hashtag statuses are rendered once for everyone, in
  [`app/streaming/shared.ts`](../app/streaming/shared.ts), and not sent to viewers who block or mute
  the author.
- **Permissions are checked for each message**, so a viewer whose roles no longer give `read:note`
  stops getting statuses.
- **Deletes** go to whoever could have had the status: its author, those it mentions and, unless it
  was direct, the author's followers. On public streams, every public status's delete is sent, as
  clients ignore ids they don't have.
- Mastodon's `direct` and `list` streams aren't there yet.

## A WebSocket's life

The route is in [`app/streaming/routes.ts`](../app/streaming/routes.ts), and each WebSocket's
session in [`app/streaming/session.ts`](../app/streaming/session.ts).

- **The token** comes from `Authorization`, the `access_token` query, or the first
  `Sec-WebSocket-Protocol`, which browsers use since they can't set headers on a WebSocket.
- **Subscribing.** The client names a stream in the URL, or sends a `subscribe` message naming it,
  and `unsubscribe` to stop. A stream it may not have, or that doesn't exist, gets an error message
  back, as on Mastodon. Binary messages close the WebSocket.
- **It closes when the token is revoked**, as every process hears on `tokens.revoked`.
- **Role changes** reach it on `roles.changed`, so its permissions are looked up again.
- **`/api/v1/streaming/health`** answers `OK`, for clients that check before connecting.

## Limits

`[streaming]` in config limits what one user can make Verso do for each event:

| Setting               | Default | Limits                                  |
| --------------------- | ------- | --------------------------------------- |
| `sockets_per_account` | 10      | WebSockets per account, on each process |
| `subscriptions`       | 100     | streams per WebSocket                   |
| `tag_length`          | 100     | a hashtag stream's tag, in characters   |

Sockets are counted per process, since processes don't share counts: with three web nodes, an
account can open 30.

## SQLite

On SQLite, messages stay in the process that sent them. A client streaming from one process only
hears of changes made in that process. Run SQLite as one `verso all` process if you use streaming.

## Tests

Tests open sessions with a fake socket, and wait for the dispatcher with its `idle()`, rather than
opening real WebSockets. [`app/streaming/routes.test.ts`](../app/streaming/routes.test.ts) opens
real ones, against a test server, for the route itself.
