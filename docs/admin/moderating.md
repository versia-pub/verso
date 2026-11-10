# Moderating

For now, Verso's moderation tools are blocking instances, suspending accounts, removing statuses,
giving moderators roles, reading reports and managing custom emoji.

## Blocking instances

Blocking an instance also blocks its subdomains. Verso refuses everything it sends, sends it
nothing, and fetches nothing from it.

You can block instances in the config, with `[federation] blocked_domains`, which takes effect when
Verso restarts and keeps the blocks with the rest of your setup. Or use
[`verso admin domains`](commands.md#verso-admin-domains), which takes effect without a restart.

```toml
[federation]
blocked_domains = ["spam.example"]
silent_blocks = true
```

With `silent_blocks`, Verso answers a blocked instance as if nothing were wrong, so it can't tell
it's blocked. Otherwise it gets a `403`.

Blocking an instance doesn't delete what Verso already has from it. Users can also block an instance
for themselves from their app, which only hides it from them.

## Reports

Users report accounts and statuses from their apps, and other instances send reports too. List the
ones no one has dealt with, and mark them as dealt with, using
[`verso admin reports`](commands.md#verso-admin-reports).

## Suspending accounts

Suspend an account, local or remote, with
[`verso admin accounts suspend`](commands.md#verso-admin-accounts). Nothing is deleted, so lifting
the suspension restores everything.

A suspended local user's apps are refused with a `403`, and their streams close. Their scheduled
statuses wait, and nothing is pushed to them. Other instances aren't told, but can no longer fetch
or follow them, and are sent nothing of theirs, except that a status an admin deletes is deleted
there too.

From a suspended remote user, Verso only accepts deletions, profile changes, and ended follows.
Their follows stay, but their instance isn't sent statuses for them, nor may it see followers-only
ones.

Local users see a suspended account's profile blank, and can't follow it or mention it. Its
statuses, follows, favourites and boosts, and its notifications to them, are hidden, and searches
don't find it unless its full address is given.

## Removing statuses

Delete any status or boost by its id with
[`verso admin statuses delete`](commands.md#verso-admin-statuses), as its author would. Boosts of it
go too. A local status's media is deleted at once, and other instances are told it's gone. A remote
status is only deleted here, and comes back if its instance sends it again.

## Moderators

Give moderators a [role](commands.md#verso-admin-roles) with the staff
[permissions](configuring.md#permissions) they need: `blocks`, `emojis` or `roles`. Mastodon apps
show `emojis` and `roles` as "Manage custom emojis" and "Manage roles".

## Trends

Verso works out which hashtags, statuses and links are trending, but shows none until you approve
them, unless `trendable_by_default` is `true` in the [config](configuring.md). Approve or reject
hashtags, accounts, links and the websites they are on with
[`verso admin trends`](commands.md#verso-admin-trends). Rejecting an account also hides its statuses
from trending statuses.

## Custom emoji

Every user can add custom emoji that only they can use. Global emoji are for everyone on the
instance. Users with the `emojis` permission can add them directly, or make one of their own global.
There's no admin command for emoji: they're managed through the API, as
[Custom emoji](../api/emojis.md) explains.
