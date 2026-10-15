import { getLogger } from "@logtape/logtape";
import { parseArgs } from "@std/cli";
import denoConfig from "../deno.json" with { type: "json" };
import { openDatabase } from "./db/database.ts";
import { migrate } from "./db/migrate.ts";
import { queues, tasks } from "./jobs/queues.ts";
import { runScheduler } from "./jobs/scheduler.ts";
import { listenForJobs } from "./jobs/wakeups.ts";
import { work } from "./jobs/worker.ts";
import { systemClock } from "./kernel/clock.ts";
import { type Config, readConfig } from "./kernel/config.ts";
import { createContext } from "./kernel/context.ts";
import { idGenerator } from "./kernel/ids.ts";
import { setUpLogging } from "./kernel/logging.ts";
import { fetchTransport } from "./kernel/transport.ts";
import { urlBuilder } from "./kernel/urls.ts";

const banner = `
███   ███ ████████ ███████▄  ▄███████▄  ▄██████▄
███   ███ ███      ███   ███ ███▄▄▄▄   ███▀  ▀███
███▄ ▄███ ███▀▀▀   ████████   ▀██████▄ ███    ███
 ▀█████▀  ███▄▄▄▄▄ ███   ███ ▄▄▄▄▄▄███ ▀███▄▄███▀
   ▀▀▀    ▀▀▀▀▀▀▀▀ ▀▀▀   ▀▀▀  ▀▀▀▀▀▀▀    ▀▀▀▀▀▀
`;

/** Serves HTTP until `signal` aborts. */
const serve = (config: Config, signal: AbortSignal): Promise<void> => {
    // deno-lint-ignore no-console -- the banner is command output, not a log line
    console.log(banner);

    const logger = getLogger(["verso", "http"]);
    const onListen = ({ hostname, port }: Deno.NetAddr) =>
        logger.info("Listening on {hostname} port {port} as {domain}", {
            hostname,
            port,
            domain: config.domain,
        });
    const server = Deno.serve({ port: config.http.port, onListen, signal }, (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/health/live") {
            return new Response("ok");
        }
        return new Response("Not Found", { status: 404 });
    });
    return server.finished;
};

/**
 * Runs as a web node (`serve`), a job worker (`work`) or both (`all`) until SIGINT or SIGTERM,
 * then finishes the requests and jobs in progress.
 */
const run = async (role: string, config: Config): Promise<void> => {
    await using db = openDatabase(config.database);
    const ctx = createContext({
        clock: systemClock,
        ids: idGenerator(systemClock),
        urls: urlBuilder(config.domain),
        transport: fetchTransport,
        db,
    });
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) Deno.addSignalListener(signal, stop);

    const logger = getLogger(["verso"]);
    const worker = ctx.ids();
    await using wakeups = role === "serve" ? undefined : await listenForJobs(config.database);
    if (role !== "serve") {
        logger.info("Working on {queues} as {worker}", { queues: Object.keys(queues), worker });
    }
    await Promise.all([
        role === "work" ? undefined : serve(config, stopping.signal),
        role === "serve"
            ? undefined
            : work(ctx, queues, { worker, pollMs: 1000, signal: stopping.signal, wakeups }),
        role === "serve"
            ? undefined
            : runScheduler(ctx, tasks, { intervalMs: 60_000, signal: stopping.signal }),
    ]);
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
    logger.info("Stopped");
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

const commands = ["serve", "work", "all", "migrate"];
const usage = "usage: verso serve|work|all|migrate [--config <path>] | verso --version";

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
        if (args._[0] === "migrate") Deno.exit(await runMigrations(result.config));
        await run(String(args._[0]), result.config);
    } else {
        // deno-lint-ignore no-console -- usage errors are command output, not log lines
        console.error(usage);
        Deno.exit(2);
    }
}
