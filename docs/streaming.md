# Streaming

Clients open a WebSocket to `/api/v1/streaming` and get statuses, notifications and conversations as
they happen. Unlike Mastodon, there's no separate streaming server: any `verso serve` or `verso all`
process takes streaming clients, on the same port as the API.

The code is in [`app/streaming/`](../app/streaming/), with each kind of stream in its own file:
`user.ts`, `lists.ts`, `public.ts`, `hashtags.ts` and `direct.ts`.

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
  ├──► list streams      the lists the author is in, each rendered as its owner sees it
  ├──► public streams    rendered once, as anyone sees it
  └──► hashtag streams   rendered once, as anyone sees it
         │
         ▼
       each session subscribed to a stream it is on ──► WebSocket
```

Messages carry ids, not statuses, so nothing private travels between processes. Each process looks
the status up itself for its own sessions. Notifications arrive the same way, on
`notifications.created`, and only go to their user's sessions. So do changes to a user's filters, on
`filters.changed`, which go to their `user` streams as `filters_changed`, with no payload.

A user's conversations arrive on `conversations.changed` and go to their `direct` streams as
`conversation`. That happens when a conversation gets a status, is marked read or unread, or loses
its latest status but still has others. A conversation that loses all its statuses is gone, so
nothing is sent, as on Mastodon.

The dispatcher, in [`app/streaming/dispatcher.ts`](../app/streaming/dispatcher.ts), subscribes once
to each channel per process, rather than once per WebSocket, and hands each message to each kind of
stream. It handles messages one at a time, so a client never gets a status's delete before its
update, though publishing doesn't wait for it. If more than 1,000 messages are waiting, new ones are
dropped and a warning is logged.

## Streams

| Stream                                    | Sends                                   |
| ----------------------------------------- | --------------------------------------- |
| `user`                                    | the home timeline, and notifications    |
| `user:notification`                       | notifications only                      |
| `public`, `public:local`, `public:remote` | the public timeline: all, local, remote |
| the same, with `:media`                   | those with media attached               |
| `hashtag`, `hashtag:local`                | public statuses with the hashtag `tag`  |
| `list`                                    | the list `list`, one of the viewer's    |
| `direct`                                  | the viewer's direct conversations       |

`user`, `list` and `direct` need `read:statuses`, and `user:notification` needs
`read:notifications`. The `user` stream only includes notifications if the token can read them.
Whose list it is takes a query, so a `list` subscription starts once that's known.

Home statuses are rendered separately for each viewer, 8 viewers at a time. Public and hashtag
statuses are rendered once for everyone, in [`app/streaming/shared.ts`](../app/streaming/shared.ts),
and aren't sent to viewers who block or mute the author. Each viewer's copy gets `filtered`, the
viewer's filters that the status matches. Permissions are checked for each message, so a viewer
whose roles no longer give `read:note` stops getting statuses.

A home status goes to its author, their followers, and the users who follow one of its hashtags, if
it's on their home timeline. A list's status goes to its owner if its author is in the list and it's
on the list's timeline.

Deletes go to everyone who could have had the status: its author, the accounts it mentions and,
unless it was direct, the author's followers. A public status's delete also goes to every user who
follows a hashtag, because its hashtags are gone with it. On public streams, every public status's
delete is sent. On list streams, the delete of every status but a direct one goes to the lists its
author is in. Clients ignore ids they don't have.

## A WebSocket's life

The route is in [`app/streaming/routes.ts`](../app/streaming/routes.ts), and each WebSocket's
session in [`app/streaming/session.ts`](../app/streaming/session.ts).

The token comes from `Authorization`, the `access_token` query parameter, or the first
`Sec-WebSocket-Protocol`, which browsers use because they can't set headers on a WebSocket.

The client names a stream in the URL, or sends a `subscribe` message, and `unsubscribe` to stop.
Asking for a stream that doesn't exist, or that the client isn't allowed, gets an error message
back. Binary messages close the WebSocket.

The WebSocket closes when its token is revoked, which every process hears on `tokens.revoked`. When
the user's roles change, `roles.changed` makes it look up its permissions again.
`/api/v1/streaming/health` returns `OK`, for clients that check before connecting.

## Limits

`[streaming]` in config limits what one user can make Verso do for each event:

| Setting               | Default | Limits                                  |
| --------------------- | ------- | --------------------------------------- |
| `sockets_per_account` | 10      | WebSockets per account, on each process |
| `subscriptions`       | 100     | streams per WebSocket                   |
| `tag_length`          | 100     | a hashtag stream's tag, in characters   |

Sockets are counted per process, since processes don't share counts, so with three web nodes an
account can open 30.

## SQLite

On SQLite, messages stay in the process that sent them, so a client only hears about changes made in
the process it's connected to. Use a single `verso all` process with SQLite if you need streaming.

## Tests

Most tests open sessions with a fake socket and wait for the dispatcher with its `idle()`, rather
than opening real WebSockets. [`app/streaming/routes.test.ts`](../app/streaming/routes.test.ts)
opens real ones, against a test server, for the route itself.
