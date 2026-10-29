{
  esbuild,
  fetchFromGitHub,
}:

# The esbuild that `deno bundle` runs. Deno would download it, which a build can't, and it works only
# with the version it was made for. When a Deno upgrade changes that version, the package build fails
# and says so: update the version and hash here.
esbuild.overrideAttrs (finalAttrs: {
  version = "0.25.5";

  src = fetchFromGitHub {
    owner = "evanw";
    repo = "esbuild";
    tag = "v${finalAttrs.version}";
    hash = "sha256-jemGZkWmN1x2+ZzJ5cLp3MoXO0oDKjtZTmZS9Be/TDw=";
  };
})
