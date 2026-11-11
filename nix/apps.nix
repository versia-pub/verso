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
  # Runs Verso from the source for debugging, on SQLite in .dev/, with debug logs and the dev login.
  # It writes .dev/config.toml the first time, which can then be edited. Arguments replace `all`.
  dev = pkgs.writeShellApplication {
    name = "dev";
    runtimeInputs = [
      pkgs.deno
      pkgs.vips
    ];
    runtimeEnv.DENO_NO_UPDATE_CHECK = "1";
    text = ''
      if [ ! -f flake.nix ]; then
        echo "Run this from the root of the repository." >&2
        exit 1
      fi

      config=.dev/config.toml
      if [ ! -f "$config" ]; then
        mkdir -p .dev
        cat >"$config" <<'EOF'
      mode = "development"
      domain = "localhost"
      database = { sqlite = ".dev/verso.db" }

      [media]
      storage = { filesystem = ".dev/media" }

      [http]
      origin = "http://localhost:8080"

      [auth]
      # A login form that takes any username, with no password.
      dev_login = true

      [logging]
      level = "debug"
      EOF
        echo "Wrote $config."
      fi

      # Only its warnings and errors, so the banner comes first.
      deno task -q verso --config "$config" migrate >/dev/null
      if [ $# -eq 0 ]; then set -- all; fi
      exec deno task -q verso --config "$config" "$@"
    '';
  };

  # Makes a Versia-branded banner for a README, with scripts/banner.ts. It needs no repository, so
  # other projects can run it too.
  banner = pkgs.writeShellApplication {
    name = "banner";
    runtimeInputs = [
      pkgs.deno
      pkgs.inkscape
    ];
    runtimeEnv.FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.inter ]; };
    text = ''
      exec deno run --no-config --no-lock --allow-read --allow-write --allow-env \
        --allow-run=inkscape ${../scripts/banner.ts} "$@"
    '';
  };
in
{
  banner = {
    type = "app";
    program = pkgs.lib.getExe banner;
    meta.description = "Make a Versia-branded README banner with a title and tagline";
  };

  dev = {
    type = "app";
    program = pkgs.lib.getExe dev;
    meta.description = "Run a local Verso from the source, with a minimal config in .dev/";
  };

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
