# 4. CI runners and cache

CI runs `nix flake check` on an x86_64 and an aarch64 GitHub runner.

The arm runners have no KVM, so NixOS VM tests run emulated there: about 4
minutes instead of 23 seconds. They still pass. If that gets too slow, run the
VM tests on x86_64 only.

`nix-community/cache-nix-action` saves the Nix store between runs, so unchanged
checks are skipped. We picked it over Magic Nix Cache, which hits GitHub's rate
limits and uploads to FlakeHub by default, and over Cachix, which costs money
for private repositories.
