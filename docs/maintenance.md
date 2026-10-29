# Maintenance

How to keep Verso up to date, and how to look after a running instance.

## Dependencies

Every dependency is code we don't control, so add one only when it pays for itself. In the pull
request, say what it replaces, how big it is, how well it's maintained, and why the standard library
or Deno's built-ins aren't enough.

To add or upgrade one:

```sh
deno add --save-exact jsr:@std/cli   # or npm:some-package
deno outdated                        # lists what has newer versions
nix run .#update-hashes
```

- **Pin exact versions**, with `--save-exact`, so an upgrade is always a change someone reviewed.
- **Commit `deno.json`, `deno.lock` and `nix/deps.nix` together.** If you forget the hash, the
  `deps-hash` check fails and tells you what to run. See
  [Build and CI](build-and-ci.md#dependencies).
- **`@versia/protocol` and `@versia/client-api`** are workspace packages in
  [`packages/`](../packages/), not downloads. Change them like the rest of the code.

## Deno, PostgreSQL and the other tools

Deno, vips, PostgreSQL and nixfmt all come from nixpkgs, pinned in `flake.lock`. To upgrade them:

```sh
nix flake update
nix run .#update-hashes   # a new Deno can change the dependency hash
nix flake check
```

GitHub Actions in `ci.yml` are pinned to a commit, with the version in a comment. Upgrade both
together.

## The Mastodon version

Clients turn features on by the Mastodon version an instance reports, which is `mastodonVersion` in
[`app/instances/render.ts`](../app/instances/render.ts), 4.3.0 for now. Raise it when Verso has what
a later version added, so clients use it.

## Unused code

- **Unused dependencies:** the `unused-dependencies` check, from
  [`scripts/unused_dependencies.ts`](../scripts/unused_dependencies.ts), compares `deno info --json`
  with the imports in `deno.json`.
- **Import cycles:** the `import-cycles` check fails on them.
- **Unused exports:** no check for now; review catches them. knip doesn't support Deno
  ([knip#1620](https://github.com/webpro-nl/knip/issues/1620)). TypeScript 7 ships a different
  package per platform, which would break our single dependency hash, and its API is still unstable.
  Revisit this when TypeScript 7's API is stable, or when review keeps missing them.

## Upgrading an instance

1. Install the new version.
2. Run `verso migrate`. All pending migrations run in one transaction, so if one fails, nothing
   changes, and the old version can keep running.
3. Restart every `verso serve`, `verso work` and `verso all` process.

On NixOS, the module runs `verso migrate` before the service starts. Processes stop gracefully on
`SIGTERM`: they finish the requests and jobs in progress first.

## The instance's keys

- **`verso admin keys rotate`** replaces the instance's key pair, such as when the old one may have
  leaked, and prints the new public key. The old one is deleted at once. Remote instances fetch the
  new key when a signature stops verifying, and every process hears of it on `federation.changed`.
- **The Web Push key never changes**, as changing it would break every subscription. See
  [Notifications and push](notifications.md#web-push).

## Admin commands

| Command                                        | Does                                      |
| ---------------------------------------------- | ----------------------------------------- |
| `verso admin domains block`, `unblock`, `list` | blocks instances, besides the config's    |
| `verso admin keys rotate`                      | replaces the instance's key pair          |
| `verso admin roles create`, `list`             | manages roles                             |
| `verso admin users grant-role`, `revoke-role`  | gives an account a role, or takes it back |

Each prints JSON, for scripts. `--help` on any of them says what it takes. They are in
[`app/admin/cli.ts`](../app/admin/cli.ts).

## Failed jobs

A job that fails for good stays in the `jobs` table as a dead letter, for `[jobs] dead_letter_days`,
30 by default. See [Events, jobs and messages](events-and-jobs.md#a-jobs-life). To see them:

```sql
SELECT queue, last_error, run_at AS died_at, payload
FROM jobs
WHERE finished_at IS NULL AND attempts >= max_attempts
ORDER BY run_at DESC;
```

To run one again once the cause is fixed, give it its attempts back. On Postgres:

```sql
UPDATE jobs SET attempts = 0, run_at = now() WHERE id = '…';
```

Many dead deliveries to one instance usually mean it is down or blocks Verso. See
[Federation](federation.md#sending).

## Logs

Verso logs to the console, through LogTape, at `[logging] level`, `info` by default. In a terminal,
logs are in colour, so the important parts stand out. Elsewhere, such as in journald or container
logs, they are plain text. `NO_COLOR` turns colour off too.

Each module logs under `verso.<module>`, such as `verso.streaming`, with values as properties. See
[`app/kernel/logging.ts`](../app/kernel/logging.ts).
