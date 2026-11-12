{
  runCommand,
  deno,
  deps,
}:

# The dependencies linked for this platform. Deno would otherwise relink them on first use, which a
# read-only copy can't take.
runCommand "verso-deno-deps-linked" { nativeBuildInputs = [ deno ]; } ''
  export DENO_DIR="$TMPDIR/deno" DENO_NO_UPDATE_CHECK=1
  cp -r --no-preserve=mode ${deps.src} "$TMPDIR/src"
  cd "$TMPDIR/src"
  cp -r --no-preserve=mode ${deps}/vendor ${deps}/node_modules .
  deno install --frozen --cached-only

  mkdir $out
  mv vendor node_modules $out/
''
