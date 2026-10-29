self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.verso;
  settingsFormat = pkgs.formats.toml { };
  # Uploads are kept under the service's state directory, the only one it can write to, unless
  # the settings keep them elsewhere. Added here, since a default in the module would be there
  # alongside an S3 bucket.
  settings = lib.recursiveUpdate (lib.optionalAttrs (!(cfg.settings.media.storage or { } ? s3)) {
    media.storage.filesystem = "/var/lib/verso/media";
  }) cfg.settings;
  configFile = settingsFormat.generate "config.toml" settings;

  # A whole value of the form ${env:NAME} or ${file:PATH}, which Verso fills in when it starts.
  isReference = value: builtins.match "\\$\\{(env|file):[^}]+}" value != null;

  # The password in a libpq URL (postgresql://user:password@host, or ?password=) or keyword string
  # (password=…), if there is one.
  postgresPassword =
    connection:
    let
      inUserInfo = builtins.match "[a-z]+://[^/@:]*:(.*)@.*" connection;
      inParameters = builtins.match "(.*[ ?&])?password *= *([^ &]*).*" connection;
    in
    if inUserInfo != null then
      builtins.head inUserInfo
    else if inParameters != null then
      builtins.elemAt inParameters 1
    else
      null;

  credentials = lib.mapAttrsToList (name: path: "${name}:${path}") cfg.credentials;

  # `verso admin …` as the service runs: as its user, with its config, and with its credentials at
  # the service's path, so ''${file:/run/credentials/verso.service/…} references still work. Only
  # a unit can be given those, so it runs in a short-lived one.
  adminCommand = pkgs.writeShellApplication {
    name = "verso-admin";
    text = ''
      unit="verso-admin-$$"
      exec ${config.systemd.package}/bin/systemd-run --quiet --pipe --wait --collect \
        --unit="$unit" --service-type=exec \
        --property=DynamicUser=yes --property=User=verso \
        --property=StateDirectory=verso --property=CacheDirectory=verso \
        --setenv=DENO_DIR=/var/cache/verso \
        ${lib.concatMapStrings (c: "--property=LoadCredential=${lib.escapeShellArg c} ") credentials}\
        --property=BindReadOnlyPaths="-/run/credentials/$unit.service:/run/credentials/verso.service" \
        ${lib.getExe cfg.package} admin --config ${configFile} "$@"
    '';
  };

  secretAdvice = "The Nix store, where settings end up, can be read by anyone on the machine. Pass the secret in services.verso.credentials and refer to it as \${file:/run/credentials/verso.service/<name>}.";
in
{
  options.services.verso = {
    enable = lib.mkEnableOption "Verso, a federated social server implementing Versia 0.6";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "verso.packages.\${system}.default";
      description = "The Verso package to run.";
    };

    settings = lib.mkOption {
      type = lib.types.submodule {
        freeformType = settingsFormat.type;
        options.domain = lib.mkOption {
          type = lib.types.str;
          example = "social.example";
          description = "The instance's domain, without a port.";
        };
      };
      default = { };
      description = "Verso's config.toml. Verso checks it on startup and refuses unknown keys.";
    };

    credentials = lib.mkOption {
      type = lib.types.attrsOf (lib.types.strMatching "/.*");
      default = { };
      example = {
        oidc = "/run/secrets/verso-oidc";
      };
      description = "Secret files, by name, given to Verso as systemd credentials so they stay out of the Nix store. Refer to one in `settings` as `\${file:/run/credentials/verso.service/<name>}`.";
    };

    database.createLocally = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to run PostgreSQL on this machine with a `verso` database and role, and point Verso at it. Turn it off to set `settings.database` yourself.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions =
      map (issuer: {
        assertion = isReference (issuer.client_secret or "");
        message = "services.verso: the client secret of ${issuer.name or "an issuer"} is written in settings. ${secretAdvice}";
      }) (cfg.settings.auth.issuers or [ ])
      ++ [
        {
          assertion =
            let
              secret = cfg.settings.media.storage.s3.secret_access_key or null;
            in
            secret == null || isReference secret;
          message = "services.verso: the S3 secret access key is written in settings. ${secretAdvice}";
        }
        {
          assertion =
            let
              password = postgresPassword (cfg.settings.database.postgres or "");
            in
            password == null || isReference password;
          message = "services.verso: the database password is written in settings.database.postgres. ${secretAdvice}";
        }
      ];

    services.verso.settings.database = lib.mkIf cfg.database.createLocally {
      postgres = "postgresql://verso@/verso?host=/run/postgresql";
    };

    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ "verso" ];
      ensureUsers = [
        {
          name = "verso";
          ensureDBOwnership = true;
        }
      ];
    };

    environment.systemPackages = [ adminCommand ];

    systemd.services.verso = {
      description = "Verso";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ lib.optional cfg.database.createLocally "postgresql.target";
      requires = lib.optional cfg.database.createLocally "postgresql.target";

      environment.DENO_DIR = "%C/verso";

      serviceConfig = {
        ExecStartPre = "${lib.getExe cfg.package} migrate --config ${configFile}";
        ExecStart = "${lib.getExe cfg.package} all --config ${configFile}";
        Restart = "on-failure";
        LoadCredential = credentials;

        # The dynamic user is named verso, so PostgreSQL's peer authentication maps it to the
        # verso role.
        DynamicUser = true;
        User = "verso";
        CacheDirectory = "verso";
        StateDirectory = "verso";

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectHome = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        SystemCallArchitectures = "native";
      };
    };
  };
}
