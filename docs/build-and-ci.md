# Build and CI

Everything is built with Nix, from [`flake.nix`](../flake.nix) and the files in [`nix/`](../nix/).
The dev shell, the package, the container image, the NixOS module and every CI check come from
there, so your machine, CI and production use the same versions of everything.

| Output                 | File               | What it is                        |
| ---------------------- | ------------------ | --------------------------------- |
| `devShells.default`    | `nix/devshell.nix` | Deno, nixfmt, PostgreSQL and vips |
| `packages.deps`        | `nix/deps.nix`     | every dependency, vendored        |
| `packages.vips`        | `nix/vips.nix`     | vips, with only Verso's formats   |
| `packages.default`     | `nix/package.nix`  | the `verso` command               |
| `packages.image`       | `nix/image.nix`    | the container image               |
| `nixosModules.default` | `nix/module.nix`   | `services.verso`, for NixOS       |
| `apps.update-hashes`   | `nix/apps.nix`     | recomputes the dependency hash    |
| `apps.dev-services`    | `nix/apps.nix`     | a throwaway PostgreSQL in `.dev/` |
| `apps.banner`          | `nix/apps.nix`     | a Versia-branded README banner    |
| `checks`               | `nix/checks.nix`   | everything CI runs                |

## Dependencies

```
deno.json, deno.lock
  │
  ▼
nix/deps.nix (fixed-output: may use the network, must match its hash)
  │  deno install --frozen  ──►  vendor/ and node_modules/
  │  trim each JSR meta.json to the versions in deno.lock
  ▼
packages.deps ──► the package, and every check
```

`nix/deps.nix` is the only fixed-output derivation, and its hash is the only one in the repository.

Deno's normal cache doesn't give the same hash on every build, because it stores HTTP headers and
download times in every file. So `deno.json` sets `"vendor": true`, which puts dependencies in
`vendor/` and `node_modules/` as plain files. `deps.nix` also trims each JSR `meta.json`, which
lists every version ever published, down to the versions in `deno.lock`. CI gets the same hash on
x86_64 and aarch64.

The downside is that your checkout gets `vendor/` and `node_modules/`, which Git and the tools
ignore. A Deno upgrade can change the hash, and an npm package with per-platform binaries would need
a hash per system.

After changing `deno.lock`, run `nix run .#update-hashes`, and commit `deno.json`, `deno.lock` and
`nix/deps.nix` together. If you forget, the `deps-hash` check fails and tells you.

## The package

`nix/package.nix` bundles `app/main.ts` and the vendored dependencies into one file with
`deno bundle`. `deno compile` then turns that into a single program with Deno's runtime, but without
its compiler or other tools. The package wraps it as `verso`, with vips on its `PATH`.

Only what `app/main.ts` imports is bundled, so tests and their dependencies, such as PGlite, are
left out. The bundle is about 3 MB, against 59 MiB for the source and its dependencies. It isn't
minified: that would save under 2 MB and a few milliseconds at startup, but rename the functions in
stack traces, and `--keep-names` breaks `require` in the bundle. The source map is embedded, without
the sources, so stack traces name the source files.

Compiling without Deno's tools saves 27 MiB and halves Verso's startup time. The program keeps a
code cache in the temporary directory, and doesn't use `DENO_DIR`.

The program runs with `--no-config --no-remote --no-npm`, since the bundle imports nothing, and
`--allow-run=vips,vipsheader`, the only programs Verso runs. File access isn't restricted, since the
config, secrets and SQLite file can be anywhere. Whatever runs Verso restricts it instead: the NixOS
module's `DynamicUser`, or the image's `nobody` user.

The version is `deno.json`'s `version`.

`deno bundle` runs esbuild, and only works with the exact version it was built for, which it would
otherwise download. [`nix/esbuild.nix`](../nix/esbuild.nix) builds that version from source.
`deno bundle` is still experimental, so a Deno upgrade can change its output, or need a different
esbuild. In that case the package build fails and says so, and you update the version and hash in
`nix/esbuild.nix`.

`deno compile` stores each file's modification time, so the build sets them all to the same time.

## The container image

`nix/image.nix` makes a layered image of the package and what it needs, with no base system. The
entrypoint is `verso` and the default command is `all`, so run `serve` and `work` in separate
containers to scale them. It runs as `nobody` (65534), who can only write to `/tmp` and mounted
volumes, and exposes port 8080.

`nix build .#image` builds a script that streams the image. Load it with
`$(nix build --print-out-paths .#image) | docker load`.

## Checks

`nix flake check` runs every check. Deno tasks run in a read-only copy of the source and
dependencies without network access, so a task that writes there or downloads anything fails.

| Check                      | Runs                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `fmt`, `lint`, `typecheck` | `deno fmt --check`, `deno lint`, `deno check`                       |
| `test-pglite`              | the tests on PGlite                                                 |
| `test-sqlite`              | the tests on SQLite                                                 |
| `test-postgres`            | the tests on a PostgreSQL started in the build                      |
| `import-cycles`            | fails on imports that go round in a circle                          |
| `unused-dependencies`      | fails on dependencies nothing imports                               |
| `deps-hash`                | fails if `deno.lock` changed but the hash in `deps.nix` didn't      |
| `agent-files`              | fails on files meant for AI tools                                   |
| `image`                    | runs the image's entrypoint, and checks it prints the version       |
| `nixos-module`             | a NixOS VM running the module, with Postgres and a credential       |
| `nixos-module-secrets`     | that the module refuses secrets written in `settings`, without a VM |
| `federation-vms`           | two instances in VMs, federating over TLS, one using Garage         |

A Deno task is stopped after 10 minutes, so a hung test fails its check instead of holding up CI.
Run one check with `nix build -L .#checks.x86_64-linux.<name>`.

## CI

CI, in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), only runs the flake's checks, on
an x86_64 and an aarch64 GitHub runner. On each, they're split into parallel jobs: the tests on
PGlite, on SQLite and on PostgreSQL, the NixOS VM tests, and everything else.

```
            ┌───────┬─────────────┬─────────────┬───────────────┬─────┐
x86_64      │ other │ test-pglite │ test-sqlite │ test-postgres │ vms │
            ├───────┼─────────────┼─────────────┼───────────────┼─────┘
aarch64     │ other │ test-pglite │ test-sqlite │ test-postgres │
            └───────┴─────────────┴─────────────┴───────────────┘
```

The `other` job evaluates every check first, so a broken one fails there whichever job builds it.

The VM tests, `nixos-module` and `federation-vms`, only run on x86_64. The arm runners have no KVM,
so the VMs would be emulated, and booting took about as long as the test driver's 300-second
timeout, failing about half the time. Anyone on aarch64 with KVM can still run them with
`nix flake check`.

`nix-community/cache-nix-action` saves the Nix store between runs, so unchanged checks are skipped.
Only the `other` job saves it, and the rest only restore it, because a repository's cache holds 10
GB and a snapshot from each job would push the others out. Magic Nix Cache hits GitHub's rate limits
and uploads to FlakeHub by default, and Cachix costs money for private repositories, so we use this
action instead.

Actions are pinned to a commit, with the version in a comment.
