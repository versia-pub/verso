{
  pkgs,
  src,
}:
let
  # Runs a deno.json task against the read-only source, so a task that tries to write fails loudly.
  denoTask =
    name: task:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.deno ]; } ''
      export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
      cd ${src}
      deno task ${task}
      touch $out
    '';
in
{
  fmt = denoTask "fmt" "fmt --check";
  lint = denoTask "lint" "lint";
  typecheck = denoTask "typecheck" "check";

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
