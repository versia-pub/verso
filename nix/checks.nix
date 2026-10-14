{
  pkgs,
  src,
  deps,
  image,
  module,
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
  test = denoTask "test" "test";
  unused-dependencies = denoTask "unused-dependencies" "unused-dependencies";

  media-spike = import ./media-spike.nix { inherit pkgs; };

  # There is no container runtime in the sandbox, so run the entrypoint the image's config names.
  image = pkgs.runCommand "image" { nativeBuildInputs = [ pkgs.jq ]; } ''
    ${image} | tar -x
    config=$(jq -r '.[0].Config' manifest.json)
    entrypoint=$(jq -r '.config.Entrypoint[0]' "$config")
    version=$("$entrypoint" --version)
    if [ "$version" != "verso ${image.imageTag}" ]; then
      echo "The image's entrypoint answered '$version', expected 'verso ${image.imageTag}'."
      exit 1
    fi
    touch $out
  '';

  nixos-module = pkgs.testers.runNixOSTest {
    name = "nixos-module";
    nodes.machine = {
      imports = [ module ];
      services.verso = {
        enable = true;
        settings.domain = "verso.test";
      };
      environment.systemPackages = [ pkgs.curl ];
    };
    testScript = ''
      machine.wait_for_unit("verso.service")
      machine.wait_for_open_port(8080)
      machine.succeed("curl --fail --silent localhost:8080/health/live | grep -x ok")
      owner = machine.succeed(
          "sudo -u postgres psql -tAc \"select pg_get_userbyid(datdba) from pg_database where datname = 'verso'\""
      )
      assert owner.strip() == "verso", f"the verso database is owned by {owner!r}"
    '';
  };

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
