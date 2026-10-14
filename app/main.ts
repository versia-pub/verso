import denoConfig from "../deno.json" with { type: "json" };

const banner = `
███   ███ ████████ ███████▄  ▄███████▄  ▄██████▄
███   ███ ███      ███   ███ ███▄▄▄▄   ███▀  ▀███
███▄ ▄███ ███▀▀▀   ████████   ▀██████▄ ███    ███
 ▀█████▀  ███▄▄▄▄▄ ███   ███ ▄▄▄▄▄▄███ ▀███▄▄███▀
   ▀▀▀    ▀▀▀▀▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀▀▀▀▀    ▀▀▀▀▀▀
`;

function serve(): void {
  // deno-lint-ignore no-console -- the banner is command output, not a log line
  console.log(banner);

  // The port is fixed until there is configuration to read it from.
  Deno.serve({ port: 8080 }, (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health/live") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  });
}

if (import.meta.main) {
  switch (Deno.args[0]) {
    case "--version":
      // deno-lint-ignore no-console -- the version is command output, not a log line
      console.log(`verso ${denoConfig.version}`);
      break;
    case "serve":
      serve();
      break;
    default:
      // deno-lint-ignore no-console -- usage errors are command output, not log lines
      console.error("usage: verso serve | verso --version");
      Deno.exit(2);
  }
}
