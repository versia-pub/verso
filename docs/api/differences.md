# Differences from Mastodon

This page lists where Verso's methods behave differently from Mastodon's. For methods Verso doesn't
have at all, see [Mastodon API compatibility](compatibility.md).

## Federation

Verso federates over Versia, not ActivityPub. Search and follows work with accounts on other Versia
instances, but accounts on Mastodon and other ActivityPub servers can't be found or followed.

- `uri` on accounts and statuses is the entity's Versia URL, which `resolve` in search can look up.
- `url` on accounts and statuses is `null`, because Verso has no web pages for them. Apps that open
  a status or profile in the browser can't do so.
- A remote account's `acct` is `username@domain`.

## Statuses

- Unlisted statuses are sent to other instances as public, since Versia has no unlisted visibility.
  Verso keeps them off its own public timelines, but other instances may show them on theirs.
- Polls and scheduled statuses aren't supported yet, and `poll` is always `null`. Posting a status
  with either fails with a `422`, rather than posting it without them.
- Quotes can't be restricted: statuses have no quote policy.
- `/api/v1/statuses/:id/context` only includes the replies Verso already has. It doesn't fetch the
  rest of a remote thread.

## Accounts

- Blocking an account isn't federated, and doesn't remove follows. It hides the account from the
  blocker in timelines, notifications, and lists of likes and boosts. A blocked account stays in the
  blocker's lists.
- Blocking a domain with `POST /api/v1/domain_blocks` blocks every account on that domain and its
  subdomains, just like blocking each one would. It isn't federated either, and the user's followers
  there stay, and can still be followed. The domain must be a domain name.
- Muting an account that's already muted updates the mute. A mute lasts at most five years.
- Featured hashtags aren't federated, since Versia has none, so remote accounts don't have any.
  Their `url` is the hashtag's, since Verso has no page of an account's statuses with it.
- Following a hashtag puts its earlier public statuses on the home timeline too, not just new ones,
  and unfollowing it takes them all off again. Verso puts the home timeline together when it's read.
- A list's title is at most 256 characters, and a request adds or removes at most 100 of its
  accounts. Lists aren't federated.
- Users with the `blocks` permission, usually moderators, see in `blocked_by` whether the account
  blocks them. For everyone else it's always `false`.
- `GET /api/v1/preferences` returns the user's posting defaults, which
  `PATCH /api/v1/accounts/update_credentials` sets. The other preferences are always Mastodon's
  defaults: sensitive media hidden, content warnings collapsed, and GIFs not autoplaying.

## Media

- Images are processed after upload: rotated upright, stripped of metadata, and scaled down to the
  instance's size limit. `POST /api/v2/media` returns `202` until processing is done, and
  `GET /api/v1/media/:id` shows when it's ready.
- Other files, such as videos, are stored as they are, with the type `unknown`. Verso doesn't
  process them yet.
- If an image can't be processed, it's deleted, since it may still contain metadata, and the upload
  fails with a `422`.

## Notifications

- `reaction` notifications tell users someone reacted to their status. See
  [Reactions](reactions.md#notifications).
- Verso never sends `poll`, `admin.sign_up`, `admin.report`, `severed_relationships`,
  `moderation_warning` or `quote` notifications.
- Notifications from blocked and muted accounts, and about statuses the user can no longer see, are
  left out of lists and counts.
- Web Push only sends to `https` endpoints. `PUT /api/v1/push/subscription` resets anything it isn't
  given, the same way creating a subscription does.

## Search

- Statuses are only searched when the query has a word, a phrase, a hashtag, `from:` or
  `in:library`, or when `account_id` is given. One-letter words only match whole words.
- `exclude_unreviewed` does nothing, since Verso doesn't review hashtags.
- `resolve` fetches accounts and statuses by their Versia URL, and accounts by `username@domain`.

## Instance

- `GET /api/v1/directory` only lists local accounts, so `local` changes nothing.
- `GET /api/v1/instance/activity` counts a week's logins by the access tokens issued that week, so a
  user who stays logged in isn't counted. Deleted statuses aren't counted.
- Every block in `GET /api/v1/instance/domain_blocks` has the severity `suspend`, since Verso blocks
  instances entirely.

## Custom emoji

- `GET /api/v1/custom_emojis` also lists the viewer's own emoji. See
  [Custom emoji](emojis.md#listing-them).
