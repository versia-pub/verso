{
  lib,
  stdenvNoCC,
  makeBinaryWrapper,
  deno,
  jq,
  vips,
  deps,
  esbuild,
}:

let
  # What Deno calls this platform's esbuild.
  esbuildPlatform =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
    }
    .${stdenvNoCC.hostPlatform.system};
in
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

  nativeBuildInputs = [
    deno
    jq
    makeBinaryWrapper
  ];

  # Verso and every dependency it imports, in one file. Tests and their dependencies, such as PGlite,
  # are left out. The source map gives each line of the bundle's place in the source, for stack
  # traces. It isn't minified: that saves under 2 MB and a few milliseconds at start, and renames
  # functions in stack traces. --keep-names would keep them, but Deno then can't make require work.
  buildPhase = ''
    runHook preBuild

    export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
    cp -r --no-preserve=mode ${deps}/vendor ${deps}/node_modules .

    # Where Deno looks for esbuild before downloading it.
    mkdir -p "$DENO_DIR/dl/esbuild-${esbuild.version}-1"
    ln -s ${lib.getExe esbuild} "$DENO_DIR/dl/esbuild-${esbuild.version}-1/esbuild-${esbuildPlatform}"

    deno bundle --frozen --platform=deno --sourcemap=linked \
      --output dist/verso.js app/main.ts \
      || { echo "If Deno now runs another esbuild, update nix/esbuild.nix." >&2; exit 1; }

    # Stack traces need only the mappings, not a copy of every source file.
    jq -c 'del(.sourcesContent)' dist/verso.js.map > dist/map.tmp
    mv dist/map.tmp dist/verso.js.map

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/verso
    cp dist/verso.js dist/verso.js.map $out/share/verso/

    # The bundle imports nothing, so Deno needs no config, lockfile or network to run it.
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
      --add-flags "run --no-config --no-remote --no-npm" \
      --add-flags "--allow-net --allow-read --allow-write --allow-env --allow-run=vips,vipsheader" \
      --add-flags "$out/share/verso/verso.js"

    runHook postInstall
  '';

  meta.mainProgram = "verso";
}
