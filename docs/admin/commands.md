# Commands

Verso is a single command, `verso`, with a subcommand for each job. Every subcommand reads
`config.toml` from the current directory, or the file given with `--config`:

```sh
verso --config /etc/verso/config.toml all
```

On NixOS, the service runs Verso for you. Run admin commands with `sudo verso-admin …`, which is
`verso admin …` with the service's config and secrets.

| Command         | Does                                                          |
| --------------- | ------------------------------------------------------------- |
| `verso all`     | answers HTTP requests and runs jobs, for a small instance     |
| `verso serve`   | answers HTTP requests only                                    |
| `verso work`    | runs jobs only                                                |
| `verso migrate` | brings the database up to date, and makes the instance's keys |
| `verso admin …` | manages the instance, as below                                |

`verso --help` lists them, `--help` after a subcommand shows its options, and `verso --version`
prints the version.

## Running Verso

`verso all` is enough for most instances. [Scaling](running.md#scaling) explains when to run
`verso serve` and `verso work` separately.

All three run until stopped. On `SIGTERM` or `SIGINT`, they stop taking new requests and jobs,
finish the ones in progress, and exit.

## Migrating

Run `verso migrate` after installing, and after every upgrade before starting the new version. All
pending migrations run in one transaction, so if one fails nothing changes and the old version keeps
working. The first run also creates the instance's key pairs, for signing and for Web Push.

## Admin commands

Admin commands print one line of JSON, so scripts can read their output. If a command fails, it
prints why and exits with 1. If it's used wrongly, such as with a missing argument, it prints its
help and exits with 2.

### `verso admin announcements`

Announcements are shown to every user in their apps. They're plain text, and can mention accounts,
link to statuses and use custom emojis. Times are ISO 8601, such as `2026-11-01T18:00Z`.

| Command                                               | Does                                              |
| ----------------------------------------------------- | ------------------------------------------------- |
| `announcements list`                                  | lists every announcement, published or not        |
| `announcements create <text> [--scheduled-at <time>]` | makes one, published at once or at the time given |
| `announcements update <id> [--text <text>]`           | changes one, keeping what isn't given             |
| `announcements publish <id>`                          | shows one to users now                            |
| `announcements unpublish <id>`                        | takes one down, until it's published again        |
| `announcements delete <id>`                           | deletes one                                       |

`create` and `update` also take `--starts-at`, `--ends-at` and `--all-day` for an event. An event
needs both times, and is taken down when it ends. With `update`, `none` removes a time.

```sh
$ verso admin announcements create "Maintenance tonight" --starts-at 2026-11-01T22:00Z --ends-at 2026-11-01T23:00Z
{"id":"01a189b0-…","text":"Maintenance tonight","published":true,…}
```

### `verso admin domains`

Blocks instances, in addition to the config's `blocked_domains`. See [Moderating](moderating.md).
Blocks take effect without a restart: straight away on PostgreSQL, and within a minute on SQLite.

| Command                                | Does                                           |
| -------------------------------------- | ---------------------------------------------- |
| `domains block <domain> [-r <reason>]` | blocks an instance, noting why                 |
| `domains unblock <domain>`             | unblocks an instance blocked with `block`      |
| `domains list`                         | lists every blocked domain, the config's first |

```sh
$ verso admin domains block spam.example --reason "Spam"
{"domain":"spam.example","changed":true,"by_config":false}

$ verso admin domains list
[{"domain":"spam.example","reason":"Spam","created_at":"2026-10-29T21:41:14.387Z",…}]
```

`changed` is `false` when there was nothing to do, such as blocking a domain twice. `by_config` is
`true` when the config also blocks the domain, in which case unblocking it here does nothing until
it's removed from the config too.

### `verso admin reports`

Users report accounts, and some of their statuses, from their apps. Other instances send reports
too, with no `reporter`, but the `instance` that sent them.

| Command                | Does                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `reports list [--all]` | lists the reports no one has dealt with, or every one with `--all` |
| `reports resolve <id>` | marks a report as dealt with                                       |

```sh
$ verso admin reports list
[{"id":"01a189a2-…","reporter":"alice","target":"spam@remote.example","category":"spam",…}]
```

`rule_ids` are the numbers of the instance's rules, in the order the config lists them.

### `verso admin roles`

Roles give accounts permissions on top of what `[permissions] default` gives everyone.

| Command                                                   | Does                            |
| --------------------------------------------------------- | ------------------------------- |
| `roles create <name> [-p <permissions>] [--priority <n>]` | creates a role, and prints it   |
| `roles list`                                              | lists every role, highest first |

```sh
$ verso admin roles create Moderator --permissions blocks,emojis --priority 50
{"id":"01a1899c-…","name":"Moderator","permissions":["blocks","emojis"],"priority":50,…}
```

`--permissions` is a comma-separated list of [permissions](configuring.md#permissions).
`--priority`, 0 by default, ranks roles: users with the `roles` permission can only manage roles
below their own. Role names are unique, ignoring case.

After that, anyone with the `roles` permission can change, delete and grant roles through the API.

### `verso admin trends`

Hashtags and accounts only trend once approved, unless `trendable_by_default` is set in the config.

| Command                            | Does                                             |
| ---------------------------------- | ------------------------------------------------ |
| `trends list`                      | lists what is trending, with whether it is shown |
| `trends approve-tag <name>`        | lets a hashtag trend                             |
| `trends reject-tag <name>`         | stops a hashtag trending                         |
| `trends approve-account <account>` | lets an account's statuses trend                 |
| `trends reject-account <account>`  | stops an account's statuses trending             |

```sh
$ verso admin trends list
{"tags":[{"name":"cats","score":16,"state":"pending"}],"accounts":[…]}
```

`state` is `approved`, `rejected` or `pending`. An account is a local username, or `username@domain`
for a remote one. Approving or rejecting takes effect at once, even for a hashtag or account that
isn't trending yet.

### `verso admin users`

| Command                               | Does                              |
| ------------------------------------- | --------------------------------- |
| `users grant-role <username> <role>`  | gives a local account a role      |
| `users revoke-role <username> <role>` | takes back a role granted by hand |

```sh
$ verso admin users grant-role alice Admin
{"username":"alice","role":"Admin","changed":true}
```

The account has to exist, so its owner must have logged in at least once. `revoke-role` only takes
back roles granted by hand, here or through the API. Roles from a login provider follow its claims,
as [Roles from your provider](configuring.md#roles-from-your-provider) explains.

### `verso admin keys`

```sh
$ verso admin keys rotate
{"public_key":"MCowBQYDK2VwAyEAW2zalJpnjrirF7LsIyD8R+YPiBWGAI+zDDBVU7oFtTQ="}
```

Replaces the instance's signing key pair, for example if the old one may have leaked. The old key is
deleted straight away. Other instances fetch the new one when signatures stop verifying, so
federation carries on. The Web Push keys are never rotated, because that would break every push
subscription.
