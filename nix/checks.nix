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
  denoTask = name: task: denoTaskWith name task { };
  denoTaskWith =
    name: task:
    {
      packages ? [ ],
      setup ? "",
    }:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.deno ] ++ packages; } ''
      export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
      cp -r --no-preserve=mode ${src} "$TMPDIR/src"
      cp -r --no-preserve=mode ${deps}/vendor ${deps}/node_modules "$TMPDIR/src/"
      chmod -R a-w "$TMPDIR/src"
      ${setup}
      cd "$TMPDIR/src"
      # A test that hangs fails the check, rather than holding it up forever. Deno names a test
      # that has run for over a minute, so the log says which.
      timeout --kill-after=10 600 deno task ${task}
      touch $out
    '';
in
{
  fmt = denoTask "fmt" "fmt --check";
  lint = denoTask "lint" "lint";
  typecheck = denoTask "typecheck" "check";
  # Tests process pictures with vips, as Verso does. Each PGlite takes most of a gigabyte until it
  # is collected, so fewer tests run at once, which takes barely longer than one per core.
  test-pglite = denoTaskWith "test-pglite" "test" {
    packages = [ pkgs.vips ];
    setup = "export DENO_JOBS=6";
  };
  test-sqlite = denoTaskWith "test-sqlite" "test" {
    packages = [ pkgs.vips ];
    setup = "export VERSO_TEST_DATABASE=sqlite";
  };
  # A throwaway PostgreSQL in $TMPDIR, reached over loopback, the only network in the sandbox.
  test-postgres = denoTaskWith "test-postgres" "test" {
    packages = [
      pkgs.postgresql_18
      pkgs.vips
    ];
    setup = ''
      # UTF-8, as real installs are, so that words of every script are words.
      initdb --pgdata="$TMPDIR/pg" --username=postgres --auth=trust --encoding=UTF8 \
        --locale=C.UTF-8 >/dev/null
      pg_ctl --pgdata="$TMPDIR/pg" --log="$TMPDIR/pg.log" --wait start \
        --options="-c listen_addresses=127.0.0.1 -c unix_socket_directories=''' -c fsync=off"
      trap 'pg_ctl --pgdata="$TMPDIR/pg" --mode=immediate stop' EXIT
      export VERSO_TEST_DATABASE=postgresql://postgres@127.0.0.1:5432/postgres
    '';
  };
  import-cycles = denoTask "import-cycles" "import-cycles";
  unused-dependencies = denoTask "unused-dependencies" "unused-dependencies";

  # There is no container runtime in the sandbox, so run the entrypoint the image's config names.
  image = pkgs.runCommand "image" { nativeBuildInputs = [ pkgs.jq ]; } ''
    ${image} | tar -x
    config=$(jq -r '.[0].Config' manifest.json)
    entrypoint=$(jq -r '.config.Entrypoint[0]' "$config")
    version=$("$entrypoint" --version 2>stderr)
    if [ "$version" != "verso ${image.imageTag}" ]; then
      echo "The image's entrypoint answered '$version', expected 'verso ${image.imageTag}'."
      exit 1
    fi
    # Warnings here, such as a missing workspace member, mean the package is incomplete.
    if [ -s stderr ]; then
      echo "The image's entrypoint printed warnings:"
      cat stderr
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
        # Secrets reach the service as systemd credentials, never through the Nix store.
        settings.auth.issuers = [
          {
            name = "Example ID";
            url = "https://id.verso.test";
            client_id = "verso";
            client_secret = "\${file:/run/credentials/verso.service/oidc}";
          }
        ];
        credentials.oidc = "/etc/verso-oidc";
      };
      environment.etc.verso-oidc.text = "s3cret";
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
      migrations = machine.succeed(
          "sudo -u postgres psql -d verso -tAc \"select tableowner from pg_tables where tablename = 'kysely_migration'\""
      )
      assert migrations.strip() == "verso", f"the migrations table is owned by {migrations!r}"
      # Verso made its media directory, which survives restarts, and checked it can write there.
      machine.succeed("test -d /var/lib/verso/media/tmp")
    '';
  };

  federation-vms = import ./federation-vms.nix { inherit pkgs module; };

  # The module refuses settings that would put a secret in the Nix store.
  nixos-module-secrets =
    let
      failures =
        settings:
        let
          system = pkgs.nixos {
            imports = [ module ];
            system.stateVersion = pkgs.lib.trivial.release;
            services.verso = {
              enable = true;
              database.createLocally = !(settings ? database);
              settings = {
                domain = "verso.test";
              }
              // settings;
            };
          };
        in
        builtins.length (
          builtins.filter (
            check: !check.assertion && pkgs.lib.hasPrefix "services.verso" check.message
          ) system.config.assertions
        );
      issuer = secret: {
        auth.issuers = [
          {
            name = "ID";
            url = "https://id.verso.test";
            client_id = "verso";
            client_secret = secret;
          }
        ];
      };
      postgres = connection: { database.postgres = connection; };
      s3 = secret: {
        media.storage.s3 = {
          endpoint = "https://s3.verso.test";
          region = "garage";
          bucket = "media";
          access_key_id = "GK0123";
          secret_access_key = secret;
        };
      };
      expected = {
        "a written secret" = failures (issuer "s3cret") == 1;
        "a file reference" = failures (issuer "\${file:/run/credentials/verso.service/oidc}") == 0;
        "an env reference" = failures (issuer "\${env:OIDC_SECRET}") == 0;
        "an escaped reference" = failures (issuer "$\${file:/s}") == 1;
        "a local database" = failures { } == 0;
        "a URL password" = failures (postgres "postgresql://verso:hunter2@db/verso") == 1;
        "a query password" = failures (postgres "postgresql://db/verso?password=hunter2") == 1;
        "a keyword password" = failures (postgres "host=db password=hunter2") == 1;
        "a password reference" =
          failures (postgres "postgresql://verso:\${file:/run/credentials/verso.service/db}@db/verso") == 0;
        "no password" = failures (postgres "postgresql://verso@db:5432/verso") == 0;
        "a written S3 secret" = failures (s3 "s3cret") == 1;
        "an S3 secret reference" = failures (s3 "\${file:/run/credentials/verso.service/s3}") == 0;
      };
      wrong = builtins.attrNames (pkgs.lib.filterAttrs (_: ok: !ok) expected);
    in
    pkgs.runCommand "nixos-module-secrets" { } (
      if wrong == [ ] then
        "touch $out"
      else
        ''
          echo "The module's secret checks are wrong for: ${builtins.concatStringsSep ", " wrong}"
          exit 1
        ''
    );

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
