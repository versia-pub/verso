# Build and CI

Everything is built with Nix, from [`flake.nix`](../flake.nix) and the files in [`nix/`](../nix/).
The dev shell, the package, the container image, the NixOS module and every CI check come from
there, so your machine, CI and production use the same versions of everything.

| Output                 | File               | What it is                        |
| ---------------------- | ------------------ | --------------------------------- |
| `devShells.default`    | `nix/devshell.nix` | Deno, nixfmt, PostgreSQL and vips |
| `packages.deps`        | `nix/deps.nix`     | every dependency, vendored        |
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

Nix builds without network access, except for fixed-output derivations, whose output must match a
hash given in advance. `nix/deps.nix` is the one such derivation, and its hash is the only one in
the repository.

Deno's normal cache can't give the same hash on every build: it stores HTTP headers and download
times in every file. So `deno.json` sets `"vendor": true`. Dependencies go into `vendor/` and
`node_modules/` as plain files, and `deps.nix` trims each JSR `meta.json`, which lists every version
ever published, down to the versions in `deno.lock`. CI got the same hash on x86_64 and aarch64.

Trade-offs:

- Your checkout gets `vendor/` and `node_modules/`. Git and the tools ignore them.
- A Deno upgrade can change the hash. Run `nix run .#update-hashes`.
- An npm package with per-platform binaries would need one hash per system.

**After changing `deno.lock`**, run `nix run .#update-hashes`, and commit `deno.json`, `deno.lock`
and `nix/deps.nix` together. The `deps-hash` check fails, and says so, if you forget.

## The package

`nix/package.nix` copies `app/`, `packages/`, `deno.json`, `deno.lock` and the vendored
dependencies, and wraps Deno as `verso`:

- **`--cached-only --frozen`**: dependencies come only from the vendored copy, never the network.
- **`--allow-run=vips,vipsheader`**: the only programs Verso runs, which the package puts on its
  `PATH`.
- **Reads and writes aren't narrowed**, since the config, secrets and SQLite file can be anywhere.
  What runs Verso narrows them: the NixOS module's `DynamicUser`, or the image's `nobody` user.

The version is `deno.json`'s `version`.

## The container image

`nix/image.nix` makes a layered image of the package and what it needs, with no base system:

- **The entrypoint is `verso`**, and the command `all`, for a small instance. Run `serve` and `work`
  in separate containers to scale them apart.
- **It runs as `nobody`** (65534), who can write only `/tmp` and mounted volumes.
- **Port 8080** is exposed.

`nix build .#image` builds a script that streams the image. Load it with
`$(nix build --print-out-paths .#image) | docker load`.

## Checks

`nix flake check` runs every check. Each Deno task runs in a read-only copy of the source and its
dependencies, without network access, so a task that writes there, or downloads, fails.

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

A Deno task that runs for 10 minutes is stopped, so a hung test fails its check rather than holding
up CI. Run one check with `nix build -L .#checks.x86_64-linux.<name>`.

## CI

CI, in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), runs the flake's checks and
nothing else, on an x86_64 and an aarch64 GitHub runner. On each, they are split into jobs that run
side by side: the tests on PGlite, on SQLite and on PostgreSQL, the NixOS VM tests, and everything
else. CI then takes as long as the slowest job, not all of them in turn.

```
            ┌───────┬─────────────┬─────────────┬───────────────┬─────┐
x86_64      │ other │ test-pglite │ test-sqlite │ test-postgres │ vms │
            ├───────┼─────────────┼─────────────┼───────────────┼─────┘
aarch64     │ other │ test-pglite │ test-sqlite │ test-postgres │
            └───────┴─────────────┴─────────────┴───────────────┘
```

The `other` job first evaluates every check, so a broken one fails there whichever job builds it.

The arm runners have no KVM, so NixOS VM tests would run emulated there. Booting the VM then took
about as long as the test driver waits for its shell, 300 seconds, so the test failed about as often
as it passed. The arm runner gets every job but the VM tests, `nixos-module` and `federation-vms`,
which run on x86_64 only. Anyone on aarch64 with KVM can still run them with `nix flake check`.

`nix-community/cache-nix-action` saves the Nix store between runs, so unchanged checks are skipped.
Only the `other` job saves it; the others only restore it, since a repository's cache holds 10 GB,
and a snapshot from each job would push the others out. We picked the action over Magic Nix Cache,
which hits GitHub's rate limits and uploads to FlakeHub by default, and over Cachix, which costs
money for private repositories.

Actions are pinned to a commit, with the version in a comment.
