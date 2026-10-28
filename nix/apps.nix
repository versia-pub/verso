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

  # A throwaway PostgreSQL for local runs and tests, kept in .dev/ until that is deleted. Object
  # storage and a cache join it once something uses them.
  dev-services = pkgs.writeShellApplication {
    name = "dev-services";
    runtimeInputs = [ pkgs.postgresql_18 ];
    text = ''
      if [ ! -f flake.nix ]; then
        echo "Run this from the root of the repository." >&2
        exit 1
      fi

      port=''${PGPORT:-5433}
      data=.dev/postgres
      if [ ! -d "$data" ]; then
        mkdir -p .dev
        # UTF-8, as real installs are, so that words of every script are words.
        initdb --pgdata="$data" --username=verso --auth=trust --no-instructions \
          --encoding=UTF8 --locale=C.UTF-8 >/dev/null
      fi

      postgres -D "$data" -p "$port" -k "$PWD/.dev" -c listen_addresses=localhost &
      server=$!
      trap 'kill "$server"' INT TERM

      until pg_isready --host=localhost --port="$port" --username=verso --quiet; do sleep 0.2; done
      createdb --host=localhost --port="$port" --username=verso verso 2>/dev/null || true

      echo "PostgreSQL is at postgresql://verso@localhost:$port/verso. Stop it with Ctrl-C."
      wait "$server" || true
    '';
  };
in
{
  dev-services = {
    type = "app";
    program = pkgs.lib.getExe dev-services;
    meta.description = "Run a throwaway PostgreSQL in .dev/ for local runs and tests";
  };

  update-hashes = {
    type = "app";
    program = pkgs.lib.getExe update-hashes;
    meta.description = "Recompute the dependency hash in nix/deps.nix after deno.lock changes";
  };
}
