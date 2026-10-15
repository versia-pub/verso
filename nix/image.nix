{
  lib,
  dockerTools,
  verso,
}:

dockerTools.streamLayeredImage {
  name = "verso";
  tag = verso.version;

  # Deno keeps its transpile and code caches in DENO_DIR, and warns at every start without one.
  extraCommands = "mkdir -m 1777 tmp";

  config = {
    Entrypoint = [ (lib.getExe verso) ];
    # Web and jobs in one container, as for a small instance. Run "serve" and "work" separately to
    # scale them apart.
    Cmd = [ "all" ];
    Env = [ "DENO_DIR=/tmp/deno" ];
    ExposedPorts."8080/tcp" = { };
    # The unprivileged "nobody" user. A numeric id needs no /etc/passwd in the image.
    User = "65534:65534";
  };
}
