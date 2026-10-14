import { getLogger } from "@logtape/logtape";
import { parseArgs } from "@std/cli";
import denoConfig from "../deno.json" with { type: "json" };
import { openDatabase } from "./db/database.ts";
import { migrate } from "./db/migrate.ts";
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

/** Applies pending migrations and returns the exit code. */
const runMigrations = async (config: Config): Promise<number> => {
  const logger = getLogger(["verso", "db"]);
  await using db = openDatabase(config.database);
  const result = await migrate(db);
  if (!result.ok) {
    logger.fatal("Migrating failed, so nothing was applied: {error}", {
      error: result.error,
    });
    return 1;
  }
  for (const name of result.applied) {
    logger.info("Applied migration {name}", { name });
  }
  if (result.applied.length === 0) logger.info("The database is up to date");
  return 0;
};

const commands = ["serve", "migrate"];
const usage = "usage: verso serve|migrate [--config <path>] | verso --version";

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["version"],
    string: ["config"],
    default: { config: "config.toml" },
  });
  if (args.version) {
    // deno-lint-ignore no-console -- the version is command output, not a log line
    console.log(`verso ${denoConfig.version}`);
  } else if (args._.length === 1 && commands.includes(String(args._[0]))) {
    const result = await readConfig(args.config);
    if (!result.ok) {
      // deno-lint-ignore no-console -- there is no logger before the config is read
      console.error(`Can't load ${args.config}:\n${result.error}`);
      Deno.exit(1);
    }
    await setUpLogging(result.config.logging.level);
    if (args._[0] === "serve") serve(result.config);
    else Deno.exit(await runMigrations(result.config));
  } else {
    // deno-lint-ignore no-console -- usage errors are command output, not log lines
    console.error(usage);
    Deno.exit(2);
  }
}
