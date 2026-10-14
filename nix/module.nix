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

    database.createLocally = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to run PostgreSQL on this machine with a `verso` database and role, and point Verso at it. Turn it off to set `settings.database` yourself.";
    };
  };

  config = lib.mkIf cfg.enable {
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
