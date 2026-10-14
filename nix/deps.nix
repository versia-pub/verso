{
  lib,
  runCommand,
  deno,
}:

let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../deno.json
      ../deno.lock
    ];
  };
in
# The Deno cache for every dependency in deno.lock. This is a fixed-output derivation, so it may
# use the network, and its hash is the only one in the repository.
runCommand "verso-deno-deps"
  {
    nativeBuildInputs = [ deno ];
    outputHashMode = "recursive";
    outputHash = "sha256-D8M0mKsXvNj1rNn2By33FmkKcXCrsz8fd58doAlGD/g=";
  }
  ''
    export DENO_DIR=$out DENO_NO_UPDATE_CHECK=1
    cd ${src}
    deno install --frozen
  ''
