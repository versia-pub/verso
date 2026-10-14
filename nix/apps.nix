{ pkgs }:

let
  system = pkgs.stdenv.hostPlatform.system;

  # Builds the dependencies with an empty hash and copies the hash Nix reports into nix/deps.nix.
  # It uses the nix already on PATH, so it talks to the local daemon with a matching version.
  update-hashes = pkgs.writeShellApplication {
    name = "update-hashes";
    runtimeInputs = [ pkgs.gnused ];
    text = ''
      if [ ! -f nix/deps.nix ]; then
        echo "Run this from the root of the repository." >&2
        exit 1
      fi

      log=$(nix build --no-link --impure --expr \
        'let flake = builtins.getFlake (toString ./.); in
         flake.packages.${system}.deps.overrideAttrs { outputHash = flake.inputs.nixpkgs.lib.fakeHash; }' \
        2>&1 || true)
      hash=$(sed -n 's/^ *got: *//p' <<<"$log")
      if [ -z "$hash" ]; then
        echo "Could not compute the dependency hash. Nix said:" >&2
        echo "$log" >&2
        exit 1
      fi

      sed -i "s|outputHash = \"[^\"]*\";|outputHash = \"$hash\";|" nix/deps.nix
      echo "nix/deps.nix now uses $hash"
    '';
  };
in
{
  update-hashes = {
    type = "app";
    program = pkgs.lib.getExe update-hashes;
    meta.description = "Recompute the dependency hash in nix/deps.nix after deno.lock changes";
  };
}
