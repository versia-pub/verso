# 2. Process images with the vips command-line tool

The old server used sharp, which ships native binaries and needed workarounds under Nix. Verso runs
the `vips` program from nixpkgs instead, behind the media port. No native npm packages are involved.

It's fast enough. Rotating a 48 MP photo upright and stripping its metadata takes about 0.4 s on a
desktop and up to 1.4 s on CI runners. A thumbnail takes less.

Trade-offs:

- Stripping metadata re-encodes JPEGs, which loses a little quality.
- vips adds about 278 MiB to the container image.
- In shell scripts, quote arguments like `"in.jpg[autorotate]"`. Nix's build shell drops them
  otherwise.
