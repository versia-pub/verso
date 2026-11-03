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
- A report sent on to another instance says its category, but not which rules were broken. One
  received keeps `spam` or `legal` if it says so; Mastodon files every one as `other`.

## Statuses

- Unlisted statuses are sent to other instances as public, since Versia has no unlisted visibility.
  Verso keeps them off its own public timelines, but other instances may show them on theirs.
- A remote poll's counts change when its instance sends the status again, and when a signed-in user
  opens the poll more than a minute after Verso last had it. Mastodon fetches the poll before it
  answers; Verso queues the fetch, so that answer has the old counts and the next has the new ones.
- An edit that leaves out `media_ids` or `poll` keeps the status's media or poll. Mastodon removes
  them. Send `poll: null` to remove a poll.
- Quotes can't be restricted: statuses have no quote policy.
- `/api/v1/statuses/:id/context` only includes the replies Verso already has. It doesn't fetch the
  rest of a remote thread.

## Preview cards

- Every card has the type `link`. Verso doesn't make video or rich embeds, or use oEmbed, so `html`
  and `embed_url` are empty.
- `authors` has the page's author but no `account`: Verso doesn't look up `fediverse:creator`.
- Pages are read as UTF-8 unless the response or the page names another charset. Mastodon also
  guesses it from the bytes.
- A card's image is downloaded and stored by Verso, scaled to fit 640×360. A page's image that is
  too big, or isn't a JPEG, PNG, GIF or WebP, isn't used.
- A failed fetch isn't tried again for the same status.

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
- A filter's title and keywords are at most 256 characters each, a request adds or changes at most
  100 of its keywords, and it expires at most 100 years from now. Filters aren't federated.
- A whole-word filter keyword counts the letters of every script as part of words, so `café` doesn't
  match `cafés`. Statuses on the public and hashtag streams say which filters they match by id, as
  well as by keyword.
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
- Verso never sends `admin.sign_up`, `admin.report`, `severed_relationships`, `moderation_warning`
  or `quote` notifications.
- Notifications from blocked and muted accounts, and about statuses the user can no longer see, are
  left out of lists and counts.
- Notification policies also apply to `reaction` notifications, as they do to likes.
  `for_limited_accounts` is kept but never applies, since moderators can't limit accounts yet.
- Notification requests are accepted or dismissed at most 100 at a time.
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
- An announcement is taken down when its event ends, and the user stream says so with
  `announcement.delete`. Mastodon hides it without telling apps.
- An announcement's statuses are the ones its links lead to when it's saved, found by their Versia
  URL. It only mentions accounts Verso already knows of.
- An announcement can be reacted to with any Unicode emoji, and with the shortcode of one of the
  instance's global custom emojis. Mastodon takes the Unicode emojis from a list of its own.

## Trends

- Trends only show what an admin approved, unless `trendable_by_default` is set. Mastodon's default
  is the same. Statuses are approved by account, not one by one.
- Verso scores hashtags, links and statuses every minute, not every five. Statuses from the last two
  days can trend.
- Hashtags are scored by public statuses only. The history shown on a hashtag counts unlisted
  statuses too.
- A local account's statuses only trend if it's discoverable. Remote accounts always count as
  discoverable, since Versia has no such setting. Statuses with no language can trend.
- Trending statuses aren't ordered by the viewer's languages, and admins don't get a mail when
  something asks for approval.
- `show_trends = false` answers `200` with an empty list, as Mastodon does. The link timeline
  answers `404` then.
- Links follow `trendable_by_default` too, which Mastodon only uses to skip review mails. A link
  trends if an admin approved it, or else its website, or else the default does. Links with no
  language can trend, and aren't ordered by the viewer's languages.
- A link counts accounts that shared it in public statuses and boosts, and its history counts the
  same. The link timeline lists the public statuses whose first link it is, by discoverable
  accounts, without those of accounts the viewer blocks or mutes. It has no `local`, `remote` or
  `only_media`, as in Mastodon.

## Suggestions

- Verso suggests the accounts in `suggested_accounts`, then those that most of the accounts the user
  follows follow, with `featured` and `friends_of_friends` as their sources. Mastodon also suggests
  popular accounts and ones like those the user just followed, which Verso doesn't.
- Mastodon shuffles the suggestions and keeps them for 15 minutes. Verso lists them in order, from
  current data.
- A local account has to be discoverable to be suggested. Remote accounts always count as
  discoverable, since Versia has no such setting.

## Custom emoji

- `GET /api/v1/custom_emojis` also lists the viewer's own emoji. See
  [Custom emoji](emojis.md#listing-them).
