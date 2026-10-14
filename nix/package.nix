{
  lib,
  stdenvNoCC,
  makeWrapper,
  deno,
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
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/verso
    cp -r . ${deps}/vendor ${deps}/node_modules $out/share/verso/

    # Dependencies come only from the vendored copy, never from the network.
    makeWrapper ${lib.getExe deno} $out/bin/verso \
      --set DENO_NO_UPDATE_CHECK 1 \
      --add-flags "run --cached-only --frozen --allow-net" \
      --add-flags "--config $out/share/verso/deno.json $out/share/verso/app/main.ts"

    runHook postInstall
  '';

  meta.mainProgram = "verso";
}
