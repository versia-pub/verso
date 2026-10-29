# Configuration

Verso reads one TOML file, `config.toml` by default, or the path given with `--config`.
[`config.example.toml`](config.example.toml) lists every setting, with its default and what it does.

The code is in [`app/kernel/config.ts`](../app/kernel/config.ts), with the larger sections in
[`app/kernel/config_sections.ts`](../app/kernel/config_sections.ts).

## Reading it

```
config.toml
  │  parse the TOML
  ▼
fill in ${env:…} and ${file:…} references (kernel/interpolate.ts)
  │
  ▼
Config.safeParse: a Zod schema, with every default
  │  unknown keys? wrong types? development-only settings in production?
  │
  ├── any problem ──► print every problem, with where it is, and exit 1
  ▼
Config, read by every command before it does anything
```

- **Unknown keys are errors**, so a typo stops Verso from starting rather than being ignored. Every
  section is a `z.strictObject`.
- **Every setting has a default** except `domain`, `database` and `[media] storage`, so a config can
  be short. Without an issuer, though, nobody can log in.
- **`mode = "development"`** allows the settings marked "development only": `[http] origin`,
  `[auth] dev_login` and `[federation] allow_internal_addresses`. In production, they are errors.
- **Some settings are checked together**, in `superRefine`: `origin` must be on `domain`, and be
  https or http on localhost, so browsers keep the login cookie.
- **What can only be checked by trying** is checked at startup: that the file store can be written
  to, and that vips is new enough. See [Media](media.md).

## Secrets

Secrets such as an issuer's client secret or a database password shouldn't sit in `config.toml`,
which on NixOS lands in the world-readable Nix store, and elsewhere often ends up in a repository.

Any string value in the config can include references, filled in when the config is read:

- `${env:NAME}`, an environment variable, for containers and `.env` files.
- `${file:/path}`, a file's contents without its trailing newline, for Docker and systemd
  credentials and other secret managers.
- `$${` for a literal `${`.

They can be mixed with text, as in `postgres = "postgresql://verso:${env:PGPASS}@db/verso"`. A
missing variable or file, or anything else in `${…}`, stops Verso from starting, and the error names
where in the config it is, never the value. References only fill in strings, so numbers such as
`http.port` can't come from them. What a reference reads isn't searched for more references.

## How settings reach the code

The config is read once, in [`app/main.ts`](../app/main.ts), and passed down. Nothing reads it
later, and nothing reads environment variables except the config's own `${env:…}` references.

| What                                       | Gets the config through                            |
| ------------------------------------------ | -------------------------------------------------- |
| adapters, such as the file store           | `contextFor` in [`app/run.ts`](../app/run.ts)      |
| values services use as they run            | `ctx.settings`, from `settingsOf`                  |
| limits routes check, such as `[search]`    | the module's route function, from `routes(config)` |
| the HTTP app: rate limits, trusted proxies | `createApp`'s options, in `run.ts`                 |

`ctx.settings` is a [`Settings`](../app/kernel/settings.ts), in the units the code uses, such as
`deliveryMs` for `[federation] delivery_hours`. Tests use `defaultSettings`, and change only what
they test. To add a setting, see [Adding a config option](guides/adding-a-config-option.md).

## Sections

| Section         | Sets                                                                 |
| --------------- | -------------------------------------------------------------------- |
| top level       | `mode`, `domain`, `database`                                         |
| `[media]`       | upload limits, cleanup, and `storage`: a folder or S3                |
| `[http]`        | the port, the trusted proxies, and `[http.rate_limit]`               |
| `[auth]`        | the development login, and `[[auth.issuers]]`: who users log in with |
| `[federation]`  | blocked domains, delivery, and fetch and rate limits for instances   |
| `[instance]`    | the name, description, contact, rules, privacy policy and terms      |
| `[limits]`      | how long names, bios and statuses may be, and how many of each       |
| `[permissions]` | what logged-out visitors and every user may do                       |
| `[streaming]`   | WebSockets and streams per user                                      |
| `[search]`      | the longest query and largest offset                                 |
| `[push]`        | how long a push service has to answer                                |
| `[jobs]`        | how long dead letters are kept                                       |
| `[logging]`     | the log level                                                        |

The `domain` can't change later, as accounts and federation are tied to it.

## NixOS

The NixOS module, in [`nix/module.nix`](../nix/module.nix), writes `services.verso.settings` as
`config.toml`. Secret files go in `services.verso.credentials`, which become systemd credentials,
referred to as `${file:/run/credentials/verso.service/<name>}`. The module refuses an issuer's
client secret, an S3 secret key or a database password written in `settings`, since they would land
in the Nix store.

## Tests

[`app/kernel/config.test.ts`](../app/kernel/config.test.ts) checks that `config.example.toml`
parses, and that its commented-out permissions are the defaults, so the example can't fall behind
the schema. It also tests each rule. `parseConfig` takes its environment and files as `sources`, so
tests don't touch the real ones.
