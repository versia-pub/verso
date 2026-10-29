# Commands

Verso is one command, `verso`, with a subcommand for each job. Every subcommand reads the config,
`config.toml` in the current directory unless `--config` says otherwise:

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

`verso --help` lists them, `--help` after any subcommand says what it takes, and `verso --version`
prints the version.

## Running Verso

`verso all` is enough for most instances. [Scaling](running.md#scaling) explains when and how to run
`verso serve` and `verso work` apart instead.

All three run until stopped. On `SIGTERM` or `SIGINT`, they stop taking new requests and jobs,
finish the ones in progress, and exit.

## Migrating

`verso migrate` brings the database up to date, after installing and after every upgrade. Run it
before starting the new version. All pending migrations run in one transaction: if one fails,
nothing changes, and the old version keeps working. On its first run, it also makes the instance's
key pairs, for signing what it sends and for Web Push.

## Admin commands

Each admin command prints one line of JSON, so scripts can read it. A command that can't do what it
was asked prints why and exits with 1. A command used wrongly, such as with a missing argument,
prints its help and exits with 2.

### `verso admin domains`

Blocks instances alongside the config's `blocked_domains`, as [Moderating](moderating.md) explains.
Blocks take effect without a restart: at once on PostgreSQL, and within a minute on SQLite.

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
`true` when the config blocks the domain too: unblocking it here then changes nothing until it is
removed from the config.

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

- **`--permissions`** is a comma-separated list of [permissions](configuring.md#permissions).
- **`--priority`**, 0 by default, ranks roles: users with the `roles` permission manage only those
  below their own.
- **Names** are unique, ignoring case.

Roles can then be changed, deleted and granted through the API, by anyone with the `roles`
permission.

### `verso admin users`

| Command                               | Does                              |
| ------------------------------------- | --------------------------------- |
| `users grant-role <username> <role>`  | gives a local account a role      |
| `users revoke-role <username> <role>` | takes back a role granted by hand |

```sh
$ verso admin users grant-role alice Admin
{"username":"alice","role":"Admin","changed":true}
```

The account must exist, so its owner must have logged in once. `revoke-role` takes back only roles
granted by hand, here or through the API. Roles a login provider grants come and go with its claims;
see [Roles from your provider](configuring.md#roles-from-your-provider).

### `verso admin keys`

```sh
$ verso admin keys rotate
{"public_key":"MCowBQYDK2VwAyEAW2zalJpnjrirF7LsIyD8R+YPiBWGAI+zDDBVU7oFtTQ="}
```

Replaces the instance's key pair, which signs everything it sends, such as when the old one may have
leaked. The old key is deleted at once. Other instances fetch the new one when a signature stops
verifying, so federation carries on. The Web Push keys never change, as that would end every push
subscription.
