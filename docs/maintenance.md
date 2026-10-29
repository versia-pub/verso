# Maintenance

How to keep Verso's code and tools up to date. To look after a running instance, see
[Running an instance](admin/running.md).

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

If the package build then says Deno runs another esbuild, update
[`nix/esbuild.nix`](../nix/esbuild.nix). If vips fails to build because a dependency isn't found,
add that feature to the ones [`nix/vips.nix`](../nix/vips.nix) leaves out.

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

## The instance's keys

Every process hears of a key rotation on `federation.changed`. The Web Push key never changes; see
[Notifications and push](notifications.md#web-push).

## Admin commands

`verso admin` manages domain blocks, roles and the instance's keys. Each command prints JSON, for
scripts. [Commands](admin/commands.md) lists them, and they are in
[`app/admin/cli.ts`](../app/admin/cli.ts).

## Failed jobs

Dead letters stay in the `jobs` table for `[jobs] dead_letter_days`. See
[Events, jobs and messages](events-and-jobs.md#a-jobs-life) for how jobs fail, and
[Running an instance](admin/running.md#failed-jobs) for how to find and retry them.

## Logs

Verso logs through LogTape. Logs printed to a terminal are in colour, so the important parts stand
out; elsewhere they are plain text. Each module logs under `verso.<module>`, such as
`verso.streaming`, with values as properties. See
[`app/kernel/logging.ts`](../app/kernel/logging.ts).
