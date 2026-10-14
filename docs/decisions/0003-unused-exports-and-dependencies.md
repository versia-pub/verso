# 3. Checking for unused exports and dependencies

Deno doesn't report exports or dependencies that nothing uses.

- **Unused dependencies:** a short script compares `deno info --json` with the imports in
  `deno.json`. It lands with the first code that uses a dependency.
- **Unused exports:** no check for now; review catches them. knip doesn't support Deno
  ([knip#1620](https://github.com/webpro-nl/knip/issues/1620)). TypeScript 7 ships a different
  package per platform, which would break our single dependency hash, and its API is still unstable.

Revisit unused exports when TypeScript 7's API is stable, or when review keeps missing them.
