# Moderating

Verso's moderation tools are few for now: blocking instances, giving moderators roles, and managing
the instance's custom emoji. There are no reports, suspensions or tools for removing other users'
statuses yet.

## Blocking instances

A blocked instance is cut off, along with its subdomains: Verso refuses what it sends, sends it
nothing, and fetches nothing from it. Block one in either of two places:

- **In the config**, with `[federation] blocked_domains`, which takes effect when Verso restarts.
  Use it for blocks you want kept with the rest of the setup.
- **With [`verso admin domains`](commands.md#verso-admin-domains)**, which takes effect without a
  restart.

```toml
[federation]
blocked_domains = ["spam.example"]
silent_blocks = true
```

With `silent_blocks`, Verso answers a blocked instance as if nothing were wrong, so it can't tell it
is blocked. Without it, Verso tells it, with a `403`.

Blocking an instance doesn't delete what Verso already has from it. Users can also block an instance
for themselves, from their app, which hides it from them alone.

## Moderators

Give moderators a [role](commands.md#verso-admin-roles) with the staff
[permissions](configuring.md#permissions) they need: `blocks`, `emojis` or `roles`. Mastodon apps
show the `emojis` and `roles` permissions as Mastodon's "Manage custom emojis" and "Manage roles".

## Custom emoji

Every user can add their own custom emoji, which only they can use. Global emoji are for everyone on
the instance: users with the `emojis` permission make them, by adding an emoji as global or making
one of theirs global. There is no admin command for emoji; they are managed through the API, as
[Custom emoji](../api/emojis.md) explains.
