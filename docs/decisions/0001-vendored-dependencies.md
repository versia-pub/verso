# 1. Vendored dependencies for Nix

Nix fetches our Deno dependencies in `nix/deps.nix`, whose hash has to be the same on every build.
Deno's normal cache can't do that: it stores HTTP headers and download times in every file.

So `deno.json` sets `"vendor": true`. Dependencies go into `vendor/` and `node_modules/` as plain
files, and `deps.nix` trims each JSR `meta.json` down to the versions in `deno.lock`. CI got the
same hash on x86_64 and aarch64.

Trade-offs:

- Your checkout gets `vendor/` and `node_modules/`. Git and the tools ignore them.
- A Deno upgrade can change the hash. Run `nix run .#update-hashes`.
- An npm package with per-platform binaries would need one hash per system.
