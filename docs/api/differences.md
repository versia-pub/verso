# Differences from Mastodon

Where a method Verso has behaves unlike Mastodon's. For methods Verso doesn't have, see
[Mastodon API compatibility](compatibility.md).

## Federation

- **Verso federates over Versia, not ActivityPub.** Search and follow finds accounts on other Versia
  instances. Accounts on Mastodon and other ActivityPub servers can't be found or followed.
- **`uri`** on accounts and statuses is the Versia URL of the entity, which `resolve` in search
  looks up.
- **`url` is `null`** on accounts and statuses, as Verso has no web pages for them. Apps that open a
  status or profile in a browser can't.
- **Remote accounts' `acct`** is `username@domain`, as on Mastodon.

## Statuses

- **Statuses can be up to 10,000 characters** by default, not 500, as the instance sets in
  `[limits]`. `/api/v2/instance` says the limit, as apps expect.
- **Unlisted statuses are sent to other instances as public**, as Versia has no unlisted. Verso
  keeps them off its own public timelines, but other instances may show them on theirs.
- **Polls and scheduled statuses** aren't there, and a status's `poll` is always `null`. Posting
  either is refused with a `422`, rather than posting the status without it.
- **Quotes** aren't restricted: statuses have no quote policy.
- **`/api/v1/statuses/:id/context`** has only the replies Verso knows of. It doesn't fetch the rest
  of a remote thread.

## Accounts

- **Blocking an account** tells neither the account nor its instance, and ends no follows. It hides
  the account from the blocker, in timelines, notifications and lists of likes and shares.
- **Blocking a domain**, with `POST /api/v1/domain_blocks`, blocks each account on the domain and
  its subdomains, as blocking each one would. Unlike on Mastodon, it tells no one, and the user's
  followers there are kept, and can still be followed. The domain must be a domain name.
- **Muting an account already muted** changes how it is muted. Mutes last at most five years.
- **Users with the `blocks` permission**, usually moderators, see in `blocked_by` whether each
  account blocks the one asked about, which is otherwise false.
- **`GET /api/v1/preferences`** gives the user's defaults for posting, which
  `PATCH /api/v1/accounts/update_credentials` changes. The others are always Mastodon's defaults:
  sensitive media hidden, content warnings closed, and GIFs still.

## Media

- **Images are processed** after the upload: turned upright, stripped of metadata, and scaled down
  to the instance's limit. `POST /api/v2/media` answers `202` until then, and
  `GET /api/v1/media/:id` says when they are ready.
- **Other files**, such as videos, are kept as they are, with the type `unknown`, as Verso doesn't
  process them yet.
- **A picture that can't be processed** is deleted, since it may still hold metadata, and the upload
  is answered with a `422`.

## Notifications

- **`reaction` notifications** say someone reacted to the user's status, as
  [Reactions](reactions.md#notifications) explains.
- **Verso never makes** `poll`, `admin.sign_up`, `admin.report`, `severed_relationships`,
  `moderation_warning` or `quote` notifications.
- **Notifications from blocked and muted accounts**, and about statuses the user may no longer see,
  are left out of lists and counts.
- **Web Push only goes to `https` endpoints.** `PUT /api/v1/push/subscription` resets what it isn't
  given, as creating a subscription does.

## Search

- **Statuses are searched** only for a query with a word, a phrase, a hashtag, `from:` or
  `in:library`, or with `account_id`. One-letter words are only found as whole words.
- **`exclude_unreviewed`** changes nothing, as Verso doesn't review hashtags.
- **`resolve`** fetches accounts and statuses by their Versia URLs, or accounts by
  `username@domain`.

## Custom emoji

- **`GET /api/v1/custom_emojis`** also lists the viewer's own emoji, as
  [Custom emoji](emojis.md#listing-them) explains.
