# Notifications and push

Local users are notified of what others do to them, as on Mastodon. Notifications are rows in the
`notifications` table, which the client API lists, singly or in groups, and which Web Push sends to
browsers and apps. Streaming sends them too.

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

- **Most are made at once**, in the transaction of what caused them.
- **Followers and boosters can be many**, so `status` and `update` notifications are made by jobs in
  the `notify` queue, 100 users to a job. The ids are found in the transaction, and a job whose
  status was deleted since notifies no one.
- **Undoing the action**, or deleting the status, deletes the notification.
- **Nobody is notified of what they did themselves**, and mentions of followers aren't also `status`
  notifications.
- **Each notification emits `notifications.created`**, which push and streaming hear.

## Reading them

- **`/api/v1/notifications`** lists them one by one, newest first, with Mastodon's `types`,
  `exclude_types` and `account_id` filters.
- **`/api/v2/notifications`** lists them in groups, as Mastodon 4.3 does. A group is one type about
  one status, or all follows, that started within 12 hours. Its key is stored on each notification
  when it is made. Reactions are grouped too.
- **Hidden accounts.** Notifications from accounts the user blocks, singly or by domain, or mutes
  with their notifications, aren't shown, by `shownQuery` in
  [`app/notifications/notification_queries.ts`](../app/notifications/notification_queries.ts). They
  are filtered when read, so unblocking shows them again.
- **Unread counts** count what is newer than the user's `notifications` marker.

Mastodon pages groups with one recursive query. Verso reads a page in parts instead, each reading
twice as many notifications as the last, so it works on SQLite too. See
[`app/notifications/group_queries.ts`](../app/notifications/group_queries.ts).

## Markers

A marker is where a user read up to in their `home` timeline or their `notifications`, so their apps
can carry on from there, as Mastodon's markers. Each is one row in `markers`, with a version that
counts how often it was set.

## Web Push

Apps subscribe with `POST /api/v1/push/subscription`, giving the push service's endpoint and the
browser's keys, and say which types of notification they want, and from whom.

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

- **One job per subscription**, in the `push` queue, grouped by the push service's host, so one that
  hangs only holds up its own pushes.
- **A push service gets 10 seconds to answer**, or `[push] timeout_seconds`. One that takes longer
  isn't tried again.
- **Push services keep a push for two days** for a device that is offline, as on Mastodon.
- **Encryption** is in [`app/push/encryption.ts`](../app/push/encryption.ts) (RFC 8291), and signing
  in [`app/push/vapid.ts`](../app/push/vapid.ts) (RFC 8292).
- **The VAPID key pair** is made once by `verso migrate`, in `vapid_keys`, and never changes:
  changing it would break every subscription. Clients get its public half from the instance and the
  subscription.
- **Titles are in English**, as Mastodon's, since Verso has no other languages yet.

### Subscriptions keep their access tokens

Verso stores only the hash of an access token, so someone who reads the database can't act as its
users. Push subscriptions are the exception: each keeps its token as it is, in
`push_subscriptions.access_token`.

Mastodon's pushes carry the token, so that clients such as its web app can fetch the notification
with it, and Verso's do the same. To put it in a push, Verso has to have it.

So someone who can read that table can act as each subscribed user, as their app, until the token is
revoked. Revoking it, or deleting the subscription, deletes the stored copy. Mastodon has the same
exposure.

Encrypting the column with a key from the config would protect against a leak of the database alone.
It isn't done for now, as it adds a key to manage and rotate. If it is done later, only this table's
queries change.
