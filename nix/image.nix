{
  lib,
  dockerTools,
  verso,
}:

dockerTools.streamLayeredImage {
  name = "verso";
  tag = verso.version;

  # For Verso's code cache, and the files it processes pictures in.
  extraCommands = "mkdir -m 1777 tmp";

  config = {
    Entrypoint = [ (lib.getExe verso) ];
    # Web and jobs in one container, as for a small instance. Run "serve" and "work" separately to
    # scale them apart.
    Cmd = [ "all" ];
    ExposedPorts."8080/tcp" = { };
    # The unprivileged "nobody" user. A numeric id needs no /etc/passwd in the image.
    User = "65534:65534";
  };
}
