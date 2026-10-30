# Maintenance

How to keep Verso's code and tools up to date. For looking after a running instance, see
[Running an instance](admin/running.md).

## Dependencies

Every dependency is code we don't control, so only add one when it's worth it. In the pull request,
say what it replaces, how big it is, how well it's maintained, and why the standard library or
Deno's built-ins aren't enough.

To add or upgrade one:

```sh
deno add --save-exact jsr:@std/cli   # or npm:some-package
deno outdated                        # lists what has newer versions
nix run .#update-hashes
```

Pin exact versions with `--save-exact`, so every upgrade is a reviewed change. Commit `deno.json`,
`deno.lock` and `nix/deps.nix` together, as [Build and CI](build-and-ci.md#dependencies) explains.
`@versia/protocol` and `@versia/client-api` are workspace packages in [`packages/`](../packages/),
so change them like the rest of the code.

## Deno, PostgreSQL and the other tools

Deno, vips, PostgreSQL and nixfmt all come from nixpkgs, pinned in `flake.lock`. To upgrade them:

```sh
nix flake update
nix run .#update-hashes   # a new Deno can change the dependency hash
nix flake check
```

If the package build then says Deno needs a different esbuild, update
[`nix/esbuild.nix`](../nix/esbuild.nix). If vips fails to build because a dependency is missing, add
that feature to the ones [`nix/vips.nix`](../nix/vips.nix) turns off.

GitHub Actions in `ci.yml` are pinned to a commit, with the version in a comment, so update both
together.

## The Mastodon version

Apps enable features based on the Mastodon version an instance reports, `mastodonVersion` in
[`app/instances/render.ts`](../app/instances/render.ts), currently 4.3.0. Raise it once Verso has
everything a later version added, so apps use it.

## Unused code

The `unused-dependencies` check, from
[`scripts/unused_dependencies.ts`](../scripts/unused_dependencies.ts), compares `deno info --json`
with the imports in `deno.json`, and the `import-cycles` check fails on import cycles.

There's no check for unused exports yet, so review has to catch them. knip doesn't support Deno
([knip#1620](https://github.com/webpro-nl/knip/issues/1620)), and TypeScript 7 ships a different
package per platform, which would break the single dependency hash, and its API isn't stable yet.
Revisit this once it is, or if review keeps missing them.

## Logs

Verso logs through LogTape, set up in [`app/kernel/logging.ts`](../app/kernel/logging.ts). Each
module logs under `verso.<module>`, such as `verso.streaming`, with values as properties rather than
in the message. How logs look to admins is in [Running an instance](admin/running.md#logs).
