# Configuring Verso

Verso reads one TOML file: `config.toml` in the directory it runs from, or the file given with
`--config`. On NixOS, `services.verso.settings` is that file, written as Nix.

[`config.example.toml`](../config.example.toml) lists every setting with its default. This page
covers the ones most instances change.

Verso checks the whole file when it starts. A typo, an unknown key or a value out of range stops it,
with a message saying what's wrong and where. Changes take effect when Verso restarts.

## Secrets

Any string can come from an environment variable or a file, which keeps secrets out of the config:

```toml
database = { postgres = "postgresql://verso:${env:DB_PASSWORD}@db.internal/verso" }

[[auth.issuers]]
client_secret = "${file:/run/secrets/oidc}"
# …
```

A file's trailing newline is dropped, and `$${` gives a literal `${`. If a variable or file is
missing, Verso won't start, and the error names the setting but never shows the value.

## Main options

```toml
domain = "social.example"
database = { postgres = "postgresql://verso@localhost/verso" }

[http]
port = 8080
trusted_proxies = ["127.0.0.1", "::1"]
```

`domain` can't change later, because accounts and federation are tied to it.

`database` is a PostgreSQL connection string, or `{ sqlite = "verso.db" }`. SQLite only suits a
single `verso all` process, since several processes on it can't tell each other what changed.

`trusted_proxies` lists your reverse proxies, as addresses or CIDR ranges. Only they are trusted to
give the client's address in `X-Forwarded-For`, which rate limits use.

## The instance

```toml
[instance]
name = "Example Social"
description = "A small place to talk."
contact = { email = "admin@social.example", account = "admin" }
rules = [
    { text = "Be kind" },
    { text = "No spam", hint = "Advertising counts as spam." },
]

[instance.privacy_policy]
text = "${file:/etc/verso/privacy.txt}"
updated = 2026-10-01
```

`contact.account` is the username of a local account to show as the instance's contact.

`extended_description`, `privacy_policy` and `terms_of_service` are plain text, with a blank line
between paragraphs, and the date they last changed, unquoted. It's easiest to keep them in files and
read them with `${file:…}`.

## Logging in

Users log in through one or more OpenID Connect providers, each an `[[auth.issuers]]` entry:

```toml
[[auth.issuers]]
name = "Example ID"
url = "https://id.social.example"
client_id = "verso"
client_secret = "${file:/run/secrets/oidc}"
registration = "open"
```

`registration` decides who gets an account when they first log in. `"open"` lets in anyone the
provider does, and `"closed"` lets in nobody. It can also require a claim to hold a value, as in
`{ claim = "groups", contains = "social-users" }`. The default is `"closed"`, so set this before
anyone logs in.

Accounts are linked to the provider's `url`, so changing it cuts them off. Logins are matched to
accounts by provider and user id only, never by email address.

A new account's username comes from `username_claim`, `preferred_username` by default. If that
username is taken, Verso adds a number, such as `username2`. Use `scopes` to request more than
`openid` and `profile`, such as `["groups"]` for a groups claim. `name` is shown on the login page
when there's more than one provider.

## Roles from your provider

Roles give accounts extra permissions. Instead of granting them by hand, you can have the provider
grant them from a claim at each login:

```toml
[[auth.issuers]]
# …
scopes = ["groups"]
roles = [{ claim = "groups", contains = "social-admins", role = "Admin" }]
```

The role has to exist already, so create it first with `verso admin roles create`. When a user logs
in without the claim, the role is taken away again. Roles granted by hand aren't affected.

## Permissions

`[permissions]` sets what everyone can do before roles add more: `anonymous` for logged-out
visitors, and `default` for every user. For example, to stop logged-out visitors from browsing the
instance through the API:

```toml
[permissions]
anonymous = []
```

Setting a list replaces the default, so include everything you want to keep. Permissions only apply
to the client API: other instances can still fetch public statuses over Versia.

| Permission             | Lets a user                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `read:account`         | view accounts and their profiles                                 |
| `read:account_follows` | view who accounts follow, and who follows them                   |
| `read:note`            | view statuses, as their visibility allows                        |
| `read:note_likes`      | view who liked the statuses they can see                         |
| `read:note_boosts`     | view who boosted the statuses they can see                       |
| `read:reaction`        | view who reacted to the statuses they can see                    |
| `read:emoji`           | view global custom emoji and their own                           |
| `search`               | search accounts, statuses and hashtags                           |
| `owner:account`        | change their own profile and settings                            |
| `owner:follow`         | follow and unfollow accounts                                     |
| `owner:block`          | block and unblock accounts                                       |
| `owner:mute`           | mute and unmute accounts                                         |
| `owner:like`           | like statuses                                                    |
| `owner:boost`          | boost statuses                                                   |
| `owner:reaction`       | react to statuses                                                |
| `owner:note`           | post and delete their own statuses                               |
| `owner:media`          | upload media                                                     |
| `owner:emoji`          | add their own custom emoji                                       |
| `owner:notification`   | view and dismiss their own notifications                         |
| `blocks`               | see who blocks each account, which moderators may need           |
| `emojis`               | add, change and delete any custom emoji, and make them global    |
| `roles`                | create, change and grant lower roles, with permissions they have |

## Media

Uploads are stored in a directory, or in an S3 bucket:

```toml
[media]
storage = { filesystem = "/var/lib/verso/media" }

# Or:
[media.storage.s3]
endpoint = "https://s3.eu-west-1.amazonaws.com"
region = "eu-west-1"
bucket = "verso-media"
access_key_id = "AKIAIOSFODNN7EXAMPLE"
secret_access_key = "${file:/run/secrets/s3}"
public_url = "https://media.social.example"
```

Set `public_url` if the bucket's files are public, for example behind a CDN. Without it, Verso
serves the files itself. `prefix` lets the bucket hold other data too.

Uploads are limited to 16 MiB, images over 3840×2160 are scaled down, and custom emoji are limited
to 256 KiB. Uploads that aren't attached to a status within 24 hours are deleted. The `[media]`
section in the example config has the settings for each.

## Federation

`blocked_domains` and `silent_blocks` block instances, as [Moderating](moderating.md) explains.

Deliveries are retried for `delivery_hours`, 48 by default. Verso stops sending to an instance it
hasn't reached for `unreachable_days`, 7 by default, until it hears from it again.
`[federation.fetch_limit]` limits how much Verso fetches from any one instance, and
`[federation.rate_limit]` limits how much one instance can send.

## Limits

`[limits]` sets the maximum length of what users write, such as statuses, bios and alt text, and how
many attachments, mentions and profile fields they can have. The example config lists each one with
its default. Links in a status count as 23 characters, however long they are.

## Rate limits

```toml
[http.rate_limit]
limit = 300
window_seconds = 300
store = "memory"
```

Each client can make `limit` requests per window, counted per account, or per IP address when
there's no account. Counts are kept in each process's `"memory"`, or in the `"database"`, so that
several web nodes share them.

## Logging

`[logging] level` is `trace`, `debug`, `info` (the default), `warning`, `error` or `fatal`. See
[Logs](running.md#logs).
