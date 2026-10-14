self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.verso;
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

    database.createLocally = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to run PostgreSQL on this machine with a `verso` database and role.";
    };
  };

  config = lib.mkIf cfg.enable {
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
        ExecStart = "${lib.getExe cfg.package} serve";
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
