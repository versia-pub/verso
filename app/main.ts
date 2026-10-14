import { getLogger } from "@logtape/logtape";
import { parseArgs } from "@std/cli";
import denoConfig from "../deno.json" with { type: "json" };
import { type Config, readConfig } from "./kernel/config.ts";
import { setUpLogging } from "./kernel/logging.ts";

const banner = `
███   ███ ████████ ███████▄  ▄███████▄  ▄██████▄
███   ███ ███      ███   ███ ███▄▄▄▄   ███▀  ▀███
███▄ ▄███ ███▀▀▀   ████████   ▀██████▄ ███    ███
 ▀█████▀  ███▄▄▄▄▄ ███   ███ ▄▄▄▄▄▄███ ▀███▄▄███▀
   ▀▀▀    ▀▀▀▀▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀▀▀▀▀    ▀▀▀▀▀▀
`;

const serve = (config: Config): void => {
  // deno-lint-ignore no-console -- the banner is command output, not a log line
  console.log(banner);

  const logger = getLogger(["verso", "http"]);
  const onListen = ({ hostname, port }: Deno.NetAddr) =>
    logger.info("Listening on {hostname} port {port} as {domain}", {
      hostname,
      port,
      domain: config.domain,
    });
  Deno.serve({ port: config.http.port, onListen }, (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health/live") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  });
};

const usage = "usage: verso serve [--config <path>] | verso --version";

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["version"],
    string: ["config"],
    default: { config: "config.toml" },
  });
  if (args.version) {
    // deno-lint-ignore no-console -- the version is command output, not a log line
    console.log(`verso ${denoConfig.version}`);
  } else if (args._.length === 1 && args._[0] === "serve") {
    const result = await readConfig(args.config);
    if (!result.ok) {
      // deno-lint-ignore no-console -- there is no logger before the config is read
      console.error(`Can't load ${args.config}:\n${result.error}`);
      Deno.exit(1);
    }
    await setUpLogging(result.config.logging.level);
    serve(result.config);
  } else {
    // deno-lint-ignore no-console -- usage errors are command output, not log lines
    console.error(usage);
    Deno.exit(2);
  }
}
