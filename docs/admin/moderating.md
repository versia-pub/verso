# Moderating

For now, Verso's moderation tools are blocking instances, giving moderators roles, and managing
custom emoji. There are no reports, suspensions or ways to remove other users' statuses yet.

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

## Moderators

Give moderators a [role](commands.md#verso-admin-roles) with the staff
[permissions](configuring.md#permissions) they need: `blocks`, `emojis` or `roles`. Mastodon apps
show `emojis` and `roles` as "Manage custom emojis" and "Manage roles".

## Custom emoji

Every user can add custom emoji that only they can use. Global emoji are for everyone on the
instance. Users with the `emojis` permission can add them directly, or make one of their own global.
There's no admin command for emoji: they're managed through the API, as
[Custom emoji](../api/emojis.md) explains.
