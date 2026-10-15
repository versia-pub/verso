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
  configFile = settingsFormat.generate "config.toml" cfg.settings;

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
        LoadCredential = lib.mapAttrsToList (name: path: "${name}:${path}") cfg.credentials;

        # The dynamic user is named verso, so PostgreSQL's peer authentication maps it to the
        # verso role.
        DynamicUser = true;
        User = "verso";
        CacheDirectory = "verso";

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
