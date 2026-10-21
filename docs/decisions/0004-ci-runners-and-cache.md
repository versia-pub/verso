# 4. CI runners and cache

CI runs the flake's checks on an x86_64 and an aarch64 GitHub runner. On each, they are split into
jobs that run side by side: the tests on PGlite, on SQLite and on PostgreSQL, the NixOS VM tests,
and everything else. CI then takes as long as the slowest job, not all of them in turn.

The arm runners have no KVM, so NixOS VM tests would run emulated there. Booting the VM then took
about as long as the test driver waits for its shell, 300 seconds, so the test failed about as often
as it passed. The arm runner gets every job but the VM tests, `nixos-module` and `federation-vms`,
which run on x86_64 only. Anyone on aarch64 with KVM can still run them with `nix flake check`.

`nix-community/cache-nix-action` saves the Nix store between runs, so unchanged checks are skipped.
Only the job for everything else saves it; the others only restore it, since a repository's cache
holds 10 GB, and a snapshot from each job would push the others out. We picked the action over Magic
Nix Cache, which hits GitHub's rate limits and uploads to FlakeHub by default, and over Cachix,
which costs money for private repositories.
