{
  lib,
  stdenvNoCC,
  makeWrapper,
  deno,
  vips,
  deps,
}:

stdenvNoCC.mkDerivation {
  pname = "verso";
  version = (lib.importJSON ../deno.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../deno.json
      ../deno.lock
      ../app
      ../packages
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/verso
    cp -r . ${deps}/vendor ${deps}/node_modules $out/share/verso/

    # Dependencies come only from the vendored copy, never from the network.
    #
    # Reads and writes can't be narrowed here: the config file is given with --config, secrets come
    # from wherever ''${file:…} points, and the SQLite file is wherever the config says. What runs
    # Verso narrows them instead. The NixOS module's DynamicUser makes the system read-only but
    # for Verso's cache, and the image runs as nobody, who can write only /tmp and mounted volumes.
    # The only programs Verso runs are vips's, for pictures, which come with it. Native libraries
    # and system information stay denied.
    makeWrapper ${lib.getExe deno} $out/bin/verso \
      --set DENO_NO_UPDATE_CHECK 1 \
      --prefix PATH : ${lib.makeBinPath [ vips ]} \
      --add-flags "run --cached-only --frozen --allow-net --allow-read --allow-write --allow-env" \
      --add-flags "--allow-run=vips,vipsheader" \
      --add-flags "--config $out/share/verso/deno.json $out/share/verso/app/main.ts"

    runHook postInstall
  '';

  meta.mainProgram = "verso";
}
