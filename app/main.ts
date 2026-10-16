import { getLogger } from "@logtape/logtape";
import { parseArgs } from "@std/cli";
import type { Kysely } from "kysely";
import denoConfig from "../deno.json" with { type: "json" };
import { type AdminCommand, adminUsage, findAdminCommand, runAdminCommand } from "./admin/cli.ts";
import { devLogin } from "./auth/dev_login.ts";
import { oidcProviders } from "./auth/oidc.ts";
import { type Database, openDatabase } from "./db/database.ts";
import { migrate } from "./db/migrate.ts";
import { createApp } from "./http/app.ts";
import { databaseRateLimitStore, memoryRateLimitStore } from "./http/rate_limits.ts";
import type { Route } from "./http/route.ts";
import { routes } from "./http/routes.ts";
import { ensureInstanceKey, instanceKey } from "./instances/keys.ts";
import { queues, tasks } from "./jobs/queues.ts";
import { runScheduler } from "./jobs/scheduler.ts";
import { listenForJobs } from "./jobs/wakeups.ts";
import { work } from "./jobs/worker.ts";
import { systemClock } from "./kernel/clock.ts";
import { type Config, readConfig } from "./kernel/config.ts";
import { type Context, createContext } from "./kernel/context.ts";
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

/** Serves `served` over HTTP until `signal` aborts. */
const serve = (
    ctx: Context,
    config: Config,
    served: readonly Route[],
    signal: AbortSignal,
): Promise<void> => {
    // deno-lint-ignore no-console -- the banner is command output, not a log line
    console.log(banner);

    const logger = getLogger(["verso", "http"]);

    const onListen = ({ hostname, port }: Deno.NetAddr) =>
        logger.info("Listening on {hostname} port {port} as {domain}", {
            hostname,
            port,
            domain: config.domain,
        });

    if (config.auth.dev_login) {
        logger.warn("The development login is on, so anyone can log in as any user");
    }

    const server = Deno.serve(
        { port: config.http.port, onListen, signal },
        createApp(ctx, served, {
            rateLimits: {
                store: config.http.rate_limit.store === "database"
                    ? databaseRateLimitStore(ctx)
                    : memoryRateLimitStore(ctx.clock),
                policy: {
                    limit: config.http.rate_limit.limit,
                    windowSeconds: config.http.rate_limit.window_seconds,
                },
            },
            trustedProxies: config.http.trusted_proxies,
            permissions: config.permissions,
        }).fetch,
    );
    return server.finished;
};

/** The context every command runs with, and the development login's routes if it is on. */
const contextFor = (config: Config, db: Kysely<Database>) => {
    const urls = urlBuilder(config.domain, config.http.origin);
    const dev = devLogin(config.auth.dev_login, urls);
    const identityProviders = {
        ...oidcProviders(config.auth.issuers, { transport: fetchTransport, clock: systemClock }),
        ...dev.providers,
    };

    const ctx = createContext({
        clock: systemClock,
        ids: idGenerator(systemClock),
        urls,
        transport: fetchTransport,
        identityProviders,
        db,
    });

    return { ctx, devRoutes: dev.routes };
};

/**
 * Runs as a web node (`serve`), a job worker (`work`) or both (`all`) until SIGINT or SIGTERM,
 * then finishes the requests and jobs in progress. Returns the exit code.
 */
const run = async (role: string, config: Config): Promise<number> => {
    await using db = openDatabase(config.database);
    const { ctx, devRoutes } = contextFor(config, db);

    const logger = getLogger(["verso"]);

    // Everything Verso sends is signed, so it can't do anything useful without a key.
    try {
        await instanceKey(ctx);
    } catch (error) {
        logger.fatal("{error}", { error: error instanceof Error ? error.message : error });
        return 1;
    }

    const stopping = new AbortController();
    const stop = () => stopping.abort();
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) Deno.addSignalListener(signal, stop);

    const worker = ctx.ids();

    await using wakeups = role === "serve" ? undefined : await listenForJobs(config.database);
    if (role !== "serve") {
        logger.info("Working on {queues} as {worker}", { queues: Object.keys(queues), worker });
    }

    await Promise.all([
        role === "work"
            ? undefined
            : serve(ctx, config, [...routes(config.limits), ...devRoutes], stopping.signal),
        role === "serve"
            ? undefined
            : work(ctx, queues, { worker, pollMs: 1000, signal: stopping.signal, wakeups }),
        role === "serve"
            ? undefined
            : runScheduler(ctx, tasks, { intervalMs: 60_000, signal: stopping.signal }),
    ]);

    for (const signal of signals) Deno.removeSignalListener(signal, stop);
    logger.info("Stopped");
    return 0;
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

    if (await ensureInstanceKey({ db, clock: systemClock, ids: idGenerator(systemClock) })) {
        logger.info("Made the instance's key pair");
    }

    return 0;
};

/** Runs an admin command and prints its result. Returns the exit code. */
const runAdmin = async (command: AdminCommand, config: Config): Promise<number> => {
    await using db = openDatabase(config.database);
    const { ctx } = contextFor(config, db);

    // deno-lint-ignore no-console -- the result is command output, not a log line
    console.log(await runAdminCommand(ctx, command));
    return 0;
};

const commands = ["serve", "work", "all", "migrate"];
const usage = "usage: verso serve|work|all|migrate|admin [--config <path>] | verso --version";

/** Reads the config, or exits saying what is wrong with it. */
const configOrExit = async (path: string): Promise<Config> => {
    const result = await readConfig(path);
    if (result.ok) return result.config;

    // deno-lint-ignore no-console -- there is no logger before the config is read
    console.error(`Can't load ${path}:\n${result.error}`);
    Deno.exit(1);
};

if (import.meta.main) {
    const args = parseArgs(Deno.args, {
        boolean: ["version"],
        string: ["config"],
        default: { config: "config.toml" },
    });

    if (args.version) {
        // deno-lint-ignore no-console -- the version is command output, not a log line
        console.log(`verso ${denoConfig.version}`);
    } else if (args._[0] === "admin") {
        const command = findAdminCommand(args._.slice(1));
        if (!command) {
            // deno-lint-ignore no-console -- usage errors are command output, not log lines
            console.error(adminUsage);
            Deno.exit(2);
        }

        const config = await configOrExit(args.config);
        await setUpLogging(config.logging.level);
        Deno.exit(await runAdmin(command, config));
    } else if (args._.length === 1 && commands.includes(String(args._[0]))) {
        const config = await configOrExit(args.config);
        await setUpLogging(config.logging.level);
        if (args._[0] === "migrate") Deno.exit(await runMigrations(config));

        Deno.exit(await run(String(args._[0]), config));
    } else {
        // deno-lint-ignore no-console -- usage errors are command output, not log lines
        console.error(usage);
        Deno.exit(2);
    }
}
