{
  mkShellNoCC,
  deno,
  nixfmt,
  postgresql_18,
  vips,
}:

mkShellNoCC {
  packages = [
    deno
    nixfmt
    # mkShell would take the dev output, whose JIT headers pull in LLVM (2.4 GiB against 152 MiB).
    postgresql_18.out
    vips
  ];
}
