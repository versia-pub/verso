# Mastodon API compatibility

Verso reports itself as Mastodon 4.3.0, so apps enable that version's features. This page compares
Verso with [Mastodon 4.3's API](https://docs.joinmastodon.org/methods/), method by method.

- ✅ works as on Mastodon.
- 🟡 works, with what's missing or different in the notes.
- ❌ isn't there yet. Apps get a `404`.

[Differences from Mastodon](differences.md) has more on the methods marked 🟡, and on others that
behave differently.

## Summary

| Area                       | Supported                                                                 |
| -------------------------- | ------------------------------------------------------------------------- |
| Logging in and apps        | all but email confirmation, through OpenID Connect                        |
| Accounts and relationships | most: profiles, follows, blocks, mutes, notes, endorsements, search       |
| Statuses                   | most: posting, editing, deleting, likes, shares, pins, bookmarks, threads |
| Media                      | images; other files kept as they are                                      |
| Timelines                  | home, with followed hashtags, lists, public and hashtag                   |
| Notifications and Web Push | all, grouped and ungrouped, without notification requests                 |
| Streaming                  | WebSocket, without the list and direct streams                            |
| Search                     | accounts, statuses and hashtags                                           |
| Instance                   | the instance, rules, policies, custom emoji                               |

Missing so far: filters, polls, scheduled statuses, reports, conversations, trends and
announcements. There's no admin API: admins use `verso admin` instead.

## Apps and logging in

| Method                                        | Verso | Notes                              |
| --------------------------------------------- | ----- | ---------------------------------- |
| `POST /api/v1/apps`                           | ✅    |                                    |
| `GET /api/v1/apps/verify_credentials`         | ✅    |                                    |
| `GET /oauth/authorize`                        | 🟡    | Logs in through an OpenID provider |
| `POST /oauth/token`                           | ✅    | Code and client credentials grants |
| `POST /oauth/revoke`                          | ✅    |                                    |
| `GET /.well-known/oauth-authorization-server` | ✅    |                                    |
| `POST /api/v1/emails/confirmations`           | ❌    | Providers handle email             |
| `GET /api/v1/emails/check_confirmation`       | ❌    |                                    |

## Accounts

| Method                                            | Verso | Notes                             |
| ------------------------------------------------- | ----- | --------------------------------- |
| `POST /api/v1/accounts`                           | ❌    | Made at a user's first login      |
| `GET /api/v1/accounts/verify_credentials`         | ✅    |                                   |
| `PATCH /api/v1/accounts/update_credentials`       | ✅    |                                   |
| `GET /api/v1/accounts/:id`                        | ✅    |                                   |
| `GET /api/v1/accounts`                            | ✅    | Several accounts by id            |
| `GET /api/v1/accounts/:id/statuses`               | ✅    |                                   |
| `GET /api/v1/accounts/:id/followers`              | ✅    |                                   |
| `GET /api/v1/accounts/:id/following`              | ✅    |                                   |
| `GET /api/v1/accounts/:id/featured_tags`          | 🟡    | Remote accounts have none         |
| `GET /api/v1/accounts/:id/lists`                  | ✅    |                                   |
| `POST /api/v1/accounts/:id/follow`                | ✅    |                                   |
| `POST /api/v1/accounts/:id/unfollow`              | ✅    |                                   |
| `POST /api/v1/accounts/:id/remove_from_followers` | ✅    |                                   |
| `POST /api/v1/accounts/:id/block`                 | 🟡    | Tells no one, and ends no follows |
| `POST /api/v1/accounts/:id/unblock`               | ✅    |                                   |
| `POST /api/v1/accounts/:id/mute`                  | ✅    |                                   |
| `POST /api/v1/accounts/:id/unmute`                | ✅    |                                   |
| `POST /api/v1/accounts/:id/pin`                   | ✅    |                                   |
| `POST /api/v1/accounts/:id/unpin`                 | ✅    |                                   |
| `POST /api/v1/accounts/:id/note`                  | ✅    |                                   |
| `GET /api/v1/accounts/relationships`              | ✅    |                                   |
| `GET /api/v1/accounts/familiar_followers`         | ✅    |                                   |
| `GET /api/v1/accounts/search`                     | ✅    |                                   |
| `GET /api/v1/accounts/lookup`                     | ✅    |                                   |
| `DELETE /api/v1/profile/avatar`                   | ✅    |                                   |
| `DELETE /api/v1/profile/header`                   | ✅    |                                   |
| `GET /api/v1/favourites`                          | ✅    |                                   |
| `GET /api/v1/bookmarks`                           | ✅    |                                   |
| `GET /api/v1/blocks`                              | ✅    |                                   |
| `GET /api/v1/mutes`                               | ✅    |                                   |
| `GET /api/v1/domain_blocks`                       | ✅    |                                   |
| `POST /api/v1/domain_blocks`                      | 🟡    | Keeps followers there             |
| `DELETE /api/v1/domain_blocks`                    | ✅    |                                   |
| `GET /api/v1/domain_blocks/preview`               | ❌    |                                   |
| `GET /api/v1/follow_requests`                     | ✅    |                                   |
| `POST /api/v1/follow_requests/:id/authorize`      | ✅    |                                   |
| `POST /api/v1/follow_requests/:id/reject`         | ✅    |                                   |
| `GET /api/v1/endorsements`                        | ✅    |                                   |
| Featured tags (4 methods)                         | ✅    |                                   |
| `GET /api/v1/tags/:name`                          | ✅    |                                   |
| `POST /api/v1/tags/:name/follow`                  | ✅    |                                   |
| `POST /api/v1/tags/:name/unfollow`                | ✅    |                                   |
| `GET /api/v1/followed_tags`                       | ✅    |                                   |
| `GET /api/v1/preferences`                         | 🟡    | Only the defaults for posting     |
| Suggestions (v1 and v2)                           | ❌    |                                   |
| Filters (v1 and v2)                               | ❌    |                                   |
| `POST /api/v1/reports`                            | ❌    |                                   |

## Statuses

| Method                                   | Verso | Notes                          |
| ---------------------------------------- | ----- | ------------------------------ |
| `POST /api/v1/statuses`                  | 🟡    | No polls or scheduling         |
| `GET /api/v1/statuses/:id`               | ✅    |                                |
| `GET /api/v1/statuses`                   | ✅    | Several statuses by id         |
| `PUT /api/v1/statuses/:id`               | 🟡    | No polls                       |
| `DELETE /api/v1/statuses/:id`            | ✅    |                                |
| `GET /api/v1/statuses/:id/context`       | 🟡    | Only replies Verso has         |
| `GET /api/v1/statuses/:id/history`       | ✅    |                                |
| `GET /api/v1/statuses/:id/source`        | ✅    |                                |
| `GET /api/v1/statuses/:id/reblogged_by`  | ✅    |                                |
| `GET /api/v1/statuses/:id/favourited_by` | ✅    |                                |
| `POST /api/v1/statuses/:id/favourite`    | ✅    |                                |
| `POST /api/v1/statuses/:id/unfavourite`  | ✅    |                                |
| `POST /api/v1/statuses/:id/reblog`       | ✅    |                                |
| `POST /api/v1/statuses/:id/unreblog`     | ✅    |                                |
| `POST /api/v1/statuses/:id/pin`          | ✅    |                                |
| `POST /api/v1/statuses/:id/unpin`        | ✅    |                                |
| `POST /api/v1/statuses/:id/bookmark`     | ✅    |                                |
| `POST /api/v1/statuses/:id/unbookmark`   | ✅    |                                |
| `POST /api/v1/statuses/:id/mute`         | ✅    |                                |
| `POST /api/v1/statuses/:id/unmute`       | ✅    |                                |
| `POST /api/v1/statuses/:id/translate`    | ❌    |                                |
| `POST /api/v2/media`                     | 🟡    | Only images are processed      |
| `GET /api/v1/media/:id`                  | ✅    |                                |
| `PUT /api/v1/media/:id`                  | ✅    |                                |
| `POST /api/v1/media`                     | ❌    | Deprecated by Mastodon; use v2 |
| Polls (2 methods)                        | ❌    |                                |
| Scheduled statuses (4 methods)           | ❌    |                                |

## Timelines

| Method                                | Verso | Notes                                 |
| ------------------------------------- | ----- | ------------------------------------- |
| `GET /api/v1/timelines/home`          | ✅    |                                       |
| `GET /api/v1/timelines/public`        | ✅    |                                       |
| `GET /api/v1/timelines/tag/:hashtag`  | ✅    |                                       |
| `GET /api/v1/timelines/link`          | ❌    |                                       |
| `GET /api/v1/timelines/list/:list_id` | ✅    |                                       |
| `GET /api/v1/markers`                 | ✅    |                                       |
| `POST /api/v1/markers`                | ✅    |                                       |
| `GET /api/v1/lists`                   | ✅    |                                       |
| `GET /api/v1/lists/:id`               | ✅    |                                       |
| `POST /api/v1/lists`                  | ✅    |                                       |
| `PUT /api/v1/lists/:id`               | ✅    |                                       |
| `DELETE /api/v1/lists/:id`            | ✅    |                                       |
| `GET /api/v1/lists/:id/accounts`      | ✅    |                                       |
| `POST /api/v1/lists/:id/accounts`     | ✅    |                                       |
| `DELETE /api/v1/lists/:id/accounts`   | ✅    |                                       |
| Conversations (4 methods)             | ❌    |                                       |
| `GET /api/v1/streaming` (WebSocket)   | 🟡    | No `list` or `direct` streams         |
| `GET /api/v1/streaming/:stream` (SSE) | ❌    | Server-sent events; use the WebSocket |
| `GET /api/v1/streaming/health`        | ✅    |                                       |

## Notifications

| Method                                          | Verso | Notes |
| ----------------------------------------------- | ----- | ----- |
| `GET /api/v1/notifications`                     | ✅    |       |
| `GET /api/v1/notifications/:id`                 | ✅    |       |
| `POST /api/v1/notifications/clear`              | ✅    |       |
| `POST /api/v1/notifications/:id/dismiss`        | ✅    |       |
| `GET /api/v1/notifications/unread_count`        | ✅    |       |
| `GET /api/v2/notifications`                     | ✅    |       |
| `GET /api/v2/notifications/:group_key`          | ✅    |       |
| `GET /api/v2/notifications/:group_key/accounts` | ✅    |       |
| `POST /api/v2/notifications/:group_key/dismiss` | ✅    |       |
| `GET /api/v2/notifications/unread_count`        | ✅    |       |
| `POST /api/v2/notifications/clear`              | ✅    |       |
| Notification requests (7 methods)               | ❌    |       |
| Notification policy (v1 and v2)                 | ❌    |       |
| `POST /api/v1/push/subscription`                | ✅    |       |
| `GET /api/v1/push/subscription`                 | ✅    |       |
| `PUT /api/v1/push/subscription`                 | ✅    |       |
| `DELETE /api/v1/push/subscription`              | ✅    |       |

## Search

| Method               | Verso | Notes                                |
| -------------------- | ----- | ------------------------------------ |
| `GET /api/v2/search` | 🟡    | Status queries need a word or filter |

## Instance

| Method                                       | Verso | Notes                        |
| -------------------------------------------- | ----- | ---------------------------- |
| `GET /api/v2/instance`                       | ✅    |                              |
| `GET /api/v1/instance`                       | ✅    | Deprecated by Mastodon       |
| `GET /api/v1/instance/rules`                 | ✅    |                              |
| `GET /api/v1/instance/extended_description`  | ✅    |                              |
| `GET /api/v1/instance/privacy_policy`        | ✅    |                              |
| `GET /api/v1/instance/peers`                 | ✅    |                              |
| `GET /api/v1/instance/activity`              | 🟡    | Logins are counted by tokens |
| `GET /api/v1/instance/domain_blocks`         | ✅    |                              |
| `GET /api/v1/instance/languages`             | ✅    |                              |
| `GET /api/v1/instance/translation_languages` | ❌    |                              |
| `GET /api/v1/custom_emojis`                  | ✅    |                              |
| `GET /api/v1/directory`                      | 🟡    | Local accounts only          |
| Trends (3 methods)                           | ❌    |                              |
| Announcements (4 methods)                    | ❌    |                              |
| `GET /api/oembed`                            | ❌    |                              |
| `GET /health`                                | ❌    | Verso has `GET /health/live` |

## Admin

Verso doesn't implement Mastodon's admin API (`/api/v1/admin/…` and `/api/v2/admin/…`). Admins use
the [`verso admin` commands](../admin/commands.md) instead.

## Beyond Mastodon 4.3

Verso also has:

- `GET /api/v1/instance/terms_of_service`, also by date, from Mastodon 4.4
- roles, with `/api/v1/roles` and `/api/v1/accounts/:id/roles`, from Versia Server
- custom emoji management, with `/api/v1/emojis`, from Versia Server
- reactions to statuses, with `reactions` on each status and `/api/v1/statuses/:id/reactions`, from
  Versia Server
