# Moderating

For now, Verso's moderation tools are blocking instances, suspending and silencing accounts,
removing statuses, giving moderators roles, reading reports and managing custom emoji.

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
[`verso admin reports`](commands.md#verso-admin-reports), or from a Mastodon app as a moderator with
the `reports` permission.

## Moderating from an app

Moderators with the `accounts` permission can list accounts, and silence, suspend and delete them,
from a Mastodon app. They can act only on remote accounts and on local users whose highest role is
below their own. Acting on an account resolves the open reports about it, which needs the `reports`
permission too. Only suspended accounts can be deleted, in the background, keeping a tombstone.

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
don't find it unless its full address is given. It isn't in the directory or suggested, and nothing
of its trends.

## Silencing accounts

Silence an account, local or remote, with
[`verso admin accounts silence`](commands.md#verso-admin-accounts), which Mastodon calls limiting.
Apps are told it's limited. Its statuses are left out of the public and hashtag timelines, and out
of threads, status search and lists of quotes for anyone who doesn't follow it, though a link to one
still opens. Its notifications to users who don't follow it go through their policy for limited
accounts, which filters them unless they change it. Its follows are requests, even to unlocked
accounts, and stay requests when an account is unlocked. A silenced local user's public statuses are
posted unlisted. It isn't in the directory or suggested, and what it posts and boosts doesn't count
toward trends. Other instances aren't told.

## Deleting accounts

Delete a local account with [`verso admin accounts delete`](commands.md#verso-admin-accounts). It is
suspended, and its statuses, media, follows and anything else it has are deleted. The account is
kept empty, with its login, its poll votes and the reports and mentions of it, so nobody can take
its username and its owner can't sign up again. Logging in again gives it back no roles. It can't be
unsuspended. Deleting it again finishes a deletion that stopped part way.

Every instance Verso knows is told, so they delete the account and its statuses too.

With `--no-tombstone`, the account is removed too, with its login and the reports about it, so its
username and login can be used again.

A remote account can't be deleted. Suspend it instead.

## Removing statuses

Delete any status or boost by its id with
[`verso admin statuses delete`](commands.md#verso-admin-statuses), as its author would. Boosts of it
go too. A local status's media is deleted at once, and other instances are told it's gone. A remote
status is only deleted here, and comes back if its instance sends it again.

## Moderators

Give moderators a [role](commands.md#verso-admin-roles) with the staff
[permissions](configuring.md#permissions) they need: `accounts`, `blocks`, `emojis`, `reports` or
`roles`. Mastodon apps show `accounts`, `emojis`, `reports` and `roles` as "Manage users", "Manage
custom emojis", "Manage reports" and "Manage roles".

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
