import denoConfig from "../deno.json" with { type: "json" };

const banner = `
███   ███ ████████ ███████▄  ▄███████▄  ▄██████▄
███   ███ ███      ███   ███ ███▄▄▄▄   ███▀  ▀███
███▄ ▄███ ███▀▀▀   ████████   ▀██████▄ ███    ███
 ▀█████▀  ███▄▄▄▄▄ ███   ███ ▄▄▄▄▄▄███ ▀███▄▄███▀
   ▀▀▀    ▀▀▀▀▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀▀▀▀▀    ▀▀▀▀▀▀
`;

/** Runs the command line and returns the process exit code. */
function main(args: string[]): number {
  if (args[0] === "--version") {
    // deno-lint-ignore no-console -- the version is command output, not a log line
    console.log(`verso ${denoConfig.version}`);
    return 0;
  }

  // Printed here until the serve, work and all roles exist to start.
  // deno-lint-ignore no-console -- the banner is command output, not a log line
  console.log(banner);
  // deno-lint-ignore no-console -- usage errors are command output, not log lines
  console.error("usage: verso --version");
  return 2;
}

if (import.meta.main) {
  Deno.exit(main(Deno.args));
}
