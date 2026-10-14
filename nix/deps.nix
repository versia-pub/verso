{
  lib,
  runCommand,
  deno,
  jq,
}:

let
  src = lib.fileset.toSource {
    root = ../.;
    # The lockfile, plus every deno.json in the workspace.
    fileset = lib.fileset.unions [
      ../deno.lock
      (lib.fileset.fileFilter (file: file.name == "deno.json") ../.)
    ];
  };
in
# The vendor/ and node_modules/ directories for every dependency in deno.lock. This is a
# fixed-output derivation, so it may use the network, and its hash is the only one in the
# repository. Deno's global cache can't be used here: it stores response headers and fetch times.
runCommand "verso-deno-deps"
  {
    nativeBuildInputs = [
      deno
      jq
    ];
    outputHashMode = "recursive";
    outputHash = "sha256-Np0C1rhWNGepS0ZFLF3JNoi2qw4Nqm90QcbpFwDpyTo=";
  }
  ''
    export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
    cp -r --no-preserve=mode ${src} "$TMPDIR/src"
    cd "$TMPDIR/src"
    deno install --frozen

    # Each JSR meta.json lists every published version, so it changes whenever a package
    # releases. Keep only the versions deno.lock pins.
    shopt -s nullglob
    for meta in vendor/jsr.io/*/*/meta.json; do
      pkg=''${meta#vendor/jsr.io/}
      jq --arg pkg "''${pkg%/meta.json}" --slurpfile lock deno.lock '
        .latest = null
        | .versions |= with_entries(select(.key as $version | $lock[0].jsr | has("\($pkg)@\($version)")))
      ' "$meta" > meta.tmp
      mv meta.tmp "$meta"
    done

    mkdir $out
    mv vendor node_modules $out/
    # Lets the deps-hash check notice when deno.lock changed but this derivation's hash didn't.
    cp deno.lock $out/
  ''
