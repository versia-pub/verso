# 4. CI runners and cache

CI runs `nix flake check` on an x86_64 and an aarch64 GitHub runner.

The arm runners have no KVM, so NixOS VM tests would run emulated there. Booting the VM then took
about as long as the test driver waits for its shell, 300 seconds, so the test failed about as often
as it passed. The arm job builds every check but the VM test, which runs on x86_64 only. Anyone on
aarch64 with KVM can still run it with `nix flake check`.

`nix-community/cache-nix-action` saves the Nix store between runs, so unchanged checks are skipped.
We picked it over Magic Nix Cache, which hits GitHub's rate limits and uploads to FlakeHub by
default, and over Cachix, which costs money for private repositories.
