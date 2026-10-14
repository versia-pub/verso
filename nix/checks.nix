{
  pkgs,
  src,
  deps,
}:
let
  # Runs a deno.json task in a read-only copy of the source and its vendored dependencies, so a
  # task that tries to write there fails loudly.
  denoTask =
    name: task:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.deno ]; } ''
      export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
      cp -r --no-preserve=mode ${src} "$TMPDIR/src"
      cp -r --no-preserve=mode ${deps}/vendor ${deps}/node_modules "$TMPDIR/src/"
      chmod -R a-w "$TMPDIR/src"
      cd "$TMPDIR/src"
      deno task ${task}
      touch $out
    '';
in
{
  fmt = denoTask "fmt" "fmt --check";
  lint = denoTask "lint" "lint";
  typecheck = denoTask "typecheck" "check";

  media-spike = import ./media-spike.nix { inherit pkgs; };

  # Nix reuses a fixed-output derivation whose hash is already in the store, so a stale hash would
  # silently keep the old dependencies.
  deps-hash = pkgs.runCommand "deps-hash" { } ''
    if ! cmp -s ${src}/deno.lock ${deps}/deno.lock; then
      echo "deno.lock has changed but the dependency hash in nix/deps.nix has not."
      echo "Run 'nix run .#update-hashes' and commit the result."
      exit 1
    fi
    touch $out
  '';

  # This codebase is written for people
  agent-files = pkgs.runCommand "agent-files" { } ''
    found=$(find ${src} \( \
      -iname AGENTS.md -o -iname CLAUDE.md -o -iname GEMINI.md \
      -o -iname .claude -o -iname .cursor -o -iname .cursorrules \
      -o -iname .windsurfrules -o -iname .clinerules -o -iname copilot-instructions.md \
    \))
    if [ -n "$found" ]; then
      echo "AI agent files are not allowed. Put any information in CONTRIBUTING.md or docs/ instead:"
      echo "$found"
      exit 1
    fi
    touch $out
  '';
}
