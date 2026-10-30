# Notifications and push

Local users are notified when others interact with them. Notifications are rows in the
`notifications` table. The client API lists them, one by one or in groups, and they're also sent
over Web Push and streaming.

The code is in [`app/notifications/`](../app/notifications/), [`app/push/`](../app/push/) and
[`app/markers/`](../app/markers/).

## Who is notified

`notifyOf`, in [`app/notifications/notifications.ts`](../app/notifications/notifications.ts), is an
event subscriber. It notifies:

| Type             | Who                                                         |
| ---------------- | ----------------------------------------------------------- |
| `mention`        | local users a status mentions                               |
| `status`         | followers who asked to be notified of the author's statuses |
| `reblog`         | the author of a boosted status                              |
| `favourite`      | the author of a liked status                                |
| `reaction`       | the author of a status someone reacted to                   |
| `follow`         | an account someone followed                                 |
| `follow_request` | a locked account someone asked to follow                    |
| `update`         | users who boosted a status that was edited                  |

Most notifications are created straight away, in the same transaction as what caused them. A status
can have a lot of followers or boosters, though, so `status` and `update` notifications are created
by jobs in the `notify` queue, 100 users per job. The users are found in the transaction, and a job
whose status has since been deleted does nothing.

Undoing the action, or deleting the status, deletes the notification. Nobody is notified about their
own actions, and a follower who is mentioned doesn't also get a `status` notification. Each
notification emits `notifications.created`, which push and streaming listen for.

## Reading them

`/api/v1/notifications` lists them one by one, newest first, with Mastodon's `types`,
`exclude_types` and `account_id` filters. `/api/v2/notifications` lists them in groups, like
Mastodon 4.3. A group is one type of notification about one status, or all follows, within 12 hours.
The group key is stored on each notification when it's created. Reactions are grouped too.

Notifications from accounts the user blocks, directly or by domain, or mutes including
notifications, are hidden by `shownQuery` in
[`app/notifications/notification_queries.ts`](../app/notifications/notification_queries.ts). They're
filtered when read, so unblocking shows them again. Unread counts count what's newer than the user's
`notifications` marker.

Mastodon pages groups with one recursive query. Verso instead reads a page in steps, each reading
twice as many notifications as the last, so it also works on SQLite. See
[`app/notifications/group_queries.ts`](../app/notifications/group_queries.ts).

## Markers

A marker records how far a user has read in their `home` timeline or their `notifications`, so their
apps can carry on from there. Each one is a row in `markers`, with a version counting how often it
was set.

## Web Push

Apps subscribe with `POST /api/v1/push/subscription`, giving the push service's endpoint and the
browser's keys, and which notifications they want, from whom.

```
notifications.created
  │
  ▼
queuePushes (in the transaction): a push job per subscription that wants it,
  │                               grouped by the push service's host
  ▼
push job
  │  look up the notification as the user sees it; gone or now hidden? stop
  │  render it as Mastodon's push: title, body, icon, access token
  │  encrypt it for the browser (aes128gcm), sign it as this instance (VAPID)
  ▼
POST to the push service
  ├─ 2xx ─────────────► done
  ├─ 404 or 410 ──────► the subscription has gone: delete it
  ├─ other 4xx ───────► give up
  └─ anything else ───► retry, a few times at most
```

Each subscription gets its own job in the `push` queue, grouped by the push service's host, so a
service that hangs only holds up its own pushes. A push service has 10 seconds to answer, or
`[push] timeout_seconds`, and one that takes longer isn't retried. Pushes ask the service to keep
them for two days if the device is offline, like Mastodon's.

Encryption is in [`app/push/encryption.ts`](../app/push/encryption.ts) (RFC 8291), and signing in
[`app/push/vapid.ts`](../app/push/vapid.ts) (RFC 8292). `verso migrate` creates the VAPID key pair
once, in `vapid_keys`, and it never changes, since that would break every subscription. Clients get
the public key from the instance and the subscription.

Titles are in English, since Verso has no translations yet.

### Subscriptions keep their access tokens

Verso only stores hashes of access tokens, so someone who reads the database can't act as its users.
Push subscriptions are the exception: each one keeps its token in full, in
`push_subscriptions.access_token`.

Mastodon's pushes include the token, so clients such as its web app can fetch the notification with
it. Verso's pushes do the same, so it has to keep the token.

This means anyone who can read that table can act as each subscribed user, through their app, until
the token is revoked. Revoking the token or deleting the subscription deletes the stored copy.
Mastodon has the same exposure.

Encrypting the column with a key from the config would protect against a leak of the database alone.
It isn't done for now, because it adds a key to manage and rotate. If it's added later, only this
table's queries change.
