# Configuring Verso

Verso reads one TOML file, `config.toml`, in the directory it runs from, or the file given with
`--config`. On NixOS, `services.verso.settings` is that file, written as Nix.
[`config.example.toml`](../config.example.toml) lists every setting, with its default. This page
covers the ones most instances change.

Verso checks the whole file when it starts. A typo, an unknown key or a value out of range stops it,
with a message saying where the problem is. Settings changes take effect when Verso restarts.

## Secrets

Any string can come from an environment variable or a file, so secrets stay out of the config:

```toml
database = { postgres = "postgresql://verso:${env:DB_PASSWORD}@db.internal/verso" }

[[auth.issuers]]
client_secret = "${file:/run/secrets/oidc}"
# …
```

A file's trailing newline is dropped. Write `$${` for a literal `${`. A missing variable or file
stops Verso, and the error names the setting, never the value.

## Main options

```toml
domain = "social.example"
database = { postgres = "postgresql://verso@localhost/verso" }

[http]
port = 8080
trusted_proxies = ["127.0.0.1", "::1"]
```

- **`domain`** can't change later, as accounts and federation are tied to it.
- **`database`** is a PostgreSQL connection string, or `{ sqlite = "verso.db" }`. SQLite suits one
  `verso all` process: with several, they can't tell each other what changed. With PostgreSQL,
  `pool_size` (30), `connect_timeout_seconds` (10) and `statement_timeout_seconds` (60) tune each
  process's connections.
- **`trusted_proxies`** are the addresses, or CIDR ranges, of your reverse proxies. Only they may
  say who the client is, in `X-Forwarded-For`, which rate limits use.

## The instance

Instance metadata:

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

- **`contact.account`** is a local username, shown as the instance's contact.
- **Long texts** are `extended_description`, `privacy_policy` and `terms_of_service`. Each is plain
  text, with a blank line between paragraphs, and the day it last changed, written without quotes.
  Keep them in files, read with `${file:…}`.

## Logging in

Users log in through one or more OpenID Connect providers. Each is an `[[auth.issuers]]` entry:

```toml
[[auth.issuers]]
name = "Example ID"
url = "https://id.social.example"
client_id = "verso"
client_secret = "${file:/run/secrets/oidc}"
registration = "open"
```

- **`registration`** controls who gets an account at their first login: `"open"` for anyone the
  provider lets in, `"closed"` for nobody, or anyone whose claim holds a value, such as
  `{ claim = "groups", contains = "social-users" }`. It is `"closed"` by default, so set it before
  the first login.
- **`url`** links the accounts to the provider, so changing it cuts them off.
- **`username_claim`** is the claim a new account's username comes from, `preferred_username` by
  default. If it is taken, Verso adds a number, e.g. `username2`.
- **`scopes`** are requested besides `openid` and `profile`, such as `["groups"]` for a groups
  claim.
- **`name`** is shown on the login page, when there is more than one provider.

Logins are matched to accounts by provider and user id only, never by email address.

## Roles from your provider

Roles give accounts more permissions. Instead of granting them by hand, a provider can grant them
from a claim, at every login:

```toml
[[auth.issuers]]
# …
scopes = ["groups"]
roles = [{ claim = "groups", contains = "social-admins", role = "Admin" }]
```

The role must already exist: create it with `verso admin roles create`. A role the provider granted
is taken back at the next login without the claim. Roles granted by hand stay.

## Permissions

`[permissions]` sets what everyone may do before roles add more: `anonymous` for logged-out
visitors, and `default` for every user. For example, to keep logged-out visitors from browsing the
instance through the API:

```toml
[permissions]
anonymous = []
```

Permissions apply to the client API. Other instances still fetch public statuses over Versia.

| Permission             | Lets one                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `read:account`         | view accounts and their profiles                               |
| `read:account_follows` | view who accounts follow, and who follows them                 |
| `read:note`            | view statuses, as their visibility allows                      |
| `read:note_likes`      | view who likes the statuses one may see                        |
| `read:note_boosts`     | view who boosts the statuses one may see                       |
| `read:reaction`        | view who reacts to the statuses one may see                    |
| `read:emoji`           | view global custom emojis and one's own                        |
| `search`               | search accounts, statuses and hashtags                         |
| `owner:account`        | change one's own profile and settings                          |
| `owner:follow`         | follow and unfollow accounts                                   |
| `owner:block`          | block and unblock accounts                                     |
| `owner:mute`           | mute and unmute accounts                                       |
| `owner:like`           | like statuses                                                  |
| `owner:boost`          | boost statuses                                                 |
| `owner:reaction`       | react to statuses                                              |
| `owner:note`           | post and delete one's own statuses                             |
| `owner:media`          | upload media                                                   |
| `owner:emoji`          | add one's own custom emojis                                    |
| `owner:notification`   | view and dismiss one's own notifications                       |
| `blocks`               | see who blocks each account, as moderators may need to         |
| `emojis`               | add, change and delete any custom emoji, and make them global  |
| `roles`                | create, change and grant lower roles, with permissions one has |

Setting a list replaces the default, so list everything you want to keep.

## Media

Uploads are kept in a directory, or in an S3 bucket:

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

- **`public_url`** is where the bucket's files are public, such as a CDN in front of it. Without it,
  Verso serves them itself.
- **`prefix`** shares the bucket with other data.
- **Limits**: `max_upload_bytes` (16 MiB), `max_pixels` (3840×2160, larger images are scaled down)
  and `max_emoji_bytes` (256 KiB). Uploads not attached to a status within `unattached_hours` (24)
  are deleted.

## Federation

`blocked_domains` and `silent_blocks` block instances, as [Moderating](moderating.md) explains.

- **`delivery_hours`** (48) is how long a delivery is retried before it is given up on.
- **`unreachable_days`** (7) is how long an instance can go unreached before Verso stops sending it
  anything, until it hears from it again.
- **`[federation.fetch_limit]`** and **`[federation.rate_limit]`** limit how much Verso fetches from
  one instance, and how much one instance may send.

## Limits

`[limits]` sets how long what users write may be, in characters, and how many of each:

| Setting             | Default | Limits                                  |
| ------------------- | ------- | --------------------------------------- |
| `status`            | 10000   | a status, with its content warning      |
| `attachments`       | 16      | media attachments on a status           |
| `mentions`          | 100     | accounts a status mentions, at most 150 |
| `media_description` | 4000    | a media attachment's alt text           |
| `display_name`      | 60      | a display name                          |
| `note`              | 10000   | a bio                                   |
| `fields`            | 16      | profile fields                          |
| `field_name`        | 255     | a profile field's name                  |
| `field_value`       | 255     | a profile field's value                 |

Links in a status count as 23 characters, whatever their length, as on Mastodon.

## Rate limits

```toml
[http.rate_limit]
limit = 300
window_seconds = 300
store = "memory"
```

Each client may make `limit` requests in each window: counted per account, or per IP address without
one. Counts are kept in each process's `"memory"`, or in the `"database"`, which several web nodes
share.

## Logging

`[logging] level` is `trace`, `debug`, `info` (the default), `warning`, `error` or `fatal`. See
[Logs](running.md#logs).
