# Moderating

Verso's moderation tools are few for now: blocking instances, giving moderators roles, and managing
the instance's custom emoji. There are no reports, suspensions or tools for removing other users'
statuses yet.

## Blocking instances

A blocked instance is cut off, along with its subdomains: Verso refuses what it sends, sends it
nothing, and fetches nothing from it. Block one in either of two places:

- **In the config**, with `[federation] blocked_domains`, which takes effect when Verso restarts.
  Use it for blocks you want kept with the rest of the setup.
- **With the CLI**, with `verso admin domains block <domain> --reason "…"`, which takes effect
  without a restart. `verso admin domains list` shows both kinds.

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

Give moderators a role with the permissions they need:

| Permission | Lets them                                                                          |
| ---------- | ---------------------------------------------------------------------------------- |
| `blocks`   | see who blocks each account, which is otherwise only the blocker's to know         |
| `emojis`   | add, change and delete any custom emoji, and make emoji global for everyone        |
| `roles`    | create, change and grant roles below their own highest, with permissions they have |

```sh
verso admin roles create Moderator --permissions blocks,emojis --priority 50
verso admin users grant-role alice Moderator
```

Mastodon apps show the `emojis` and `roles` permissions as Mastodon's "Manage custom emojis" and
"Manage roles".

## Custom emoji

Every user can add their own custom emoji, which only they can use. Global emoji are for everyone on
the instance. Users with the `emojis` permission make them, by uploading an emoji with `global` set,
or by making one of theirs global. A user's own emoji replaces a global one of the same shortcode,
for them.

Emoji are managed through the API, with `/api/v1/emojis`. Remote instances' emoji arrive with their
statuses, and aren't managed here.
