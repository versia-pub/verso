{
  description = "Verso: a federated social server implementing Versia 0.6";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # `nix fmt` passes no paths, so use the treefmt wrapper that formats the whole tree.
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
