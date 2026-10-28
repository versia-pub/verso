import { Command } from "@cliffy/command";
import { getLogger } from "@logtape/logtape";
import type { Kysely } from "kysely";
import denoConfig from "../deno.json" with { type: "json" };
import { adminCommand, AdminError, missingCommand } from "./admin/cli.ts";
import { devLogin } from "./auth/dev_login.ts";
import { oidcProviders } from "./auth/oidc.ts";
import { type Database, openDatabase } from "./db/database.ts";
import { postgresPubSub } from "./db/postgres_pubsub.ts";
import { migrate } from "./db/migrate.ts";
import { forgetWhenTold } from "./federation/caches.ts";
import { createApp } from "./http/app.ts";
import { memoryRateLimitStore } from "./http/rate_limits.ts";
import { databaseRateLimitStore } from "./http/rate_limit_queries.ts";
import type { Route } from "./http/route.ts";
import { routes } from "./http/routes.ts";
import { appServices, federation, subscribers } from "./services.ts";
import { ensureInstanceKey, instanceKey } from "./instances/keys.ts";
import { ensureVapidKey, vapidKey } from "./push/keys.ts";
import { indexUnindexed } from "./search/notes.ts";
import { queues, tasks } from "./jobs/queues.ts";
import { runScheduler } from "./jobs/scheduler.ts";
import { listenForJobs } from "./jobs/wakeups.ts";
import { work } from "./jobs/worker.ts";
import { systemClock } from "./kernel/clock.ts";
import { type Config, readConfig } from "./kernel/config.ts";
import { settingsOf } from "./kernel/settings.ts";
import { type Context, createContext, type PubSub } from "./kernel/context.ts";
import { filesFor } from "./kernel/file_stores.ts";
import { idGenerator } from "./kernel/ids.ts";
import { memoryPubSub } from "./kernel/pubsub.ts";
import { setUpLogging } from "./kernel/logging.ts";
import { federationTransport, fetchTransport, timedTransport } from "./kernel/transport.ts";
import { urlBuilder } from "./kernel/urls.ts";
import { vipsImages } from "./kernel/vips_images.ts";

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
            services: appServices(),
            rateLimits: {
                store: config.http.rate_limit.store === "database"
                    ? databaseRateLimitStore(ctx)
                    : memoryRateLimitStore(ctx.clock),
                policy: {
                    limit: config.http.rate_limit.limit,
                    windowSeconds: config.http.rate_limit.window_seconds,
                },
                instancePolicy: {
                    limit: config.federation.rate_limit.limit,
                    windowSeconds: config.federation.rate_limit.window_seconds,
                },
            },
            trustedProxies: config.http.trusted_proxies,
            permissions: config.permissions,
            silentBlocks: config.federation.silent_blocks,
        }).fetch,
    );
    return server.finished;
};

/**
 * Sends messages to other processes through Postgres. SQLite has no notifications, so there only
 * this process hears them.
 */
const pubSubFor = (config: Config, db: Kysely<Database>): PubSub & AsyncDisposable =>
    "postgres" in config.database
        ? postgresPubSub(db, config.database.postgres)
        : { ...memoryPubSub(), [Symbol.asyncDispose]: () => Promise.resolve() };

/** The context every command runs with, and the development login's routes if it is on. */
const contextFor = (config: Config, db: Kysely<Database>, pubsub: PubSub) => {
    const urls = urlBuilder(config.domain, config.http.origin);
    const dev = devLogin(config.auth.dev_login, urls);
    const identityProviders = {
        ...oidcProviders(config.auth.issuers, {
            transport: timedTransport(fetchTransport, config.auth.timeout_seconds * 1000),
            clock: systemClock,
        }),
        ...dev.providers,
    };

    const ctx = createContext({
        clock: systemClock,
        ids: idGenerator(systemClock),
        urls,
        transport: federationTransport({
            allowInternal: config.federation.allow_internal_addresses,
        }),
        files: filesFor(config.media.storage, fetchTransport, systemClock),
        images: vipsImages({ maxPixels: config.media.max_pixels }),
        identityProviders,
        federation: federation(config.federation.blocked_domains, {
            fetchLimit: {
                limit: config.federation.fetch_limit.limit,
                windowMs: config.federation.fetch_limit.window_seconds * 1000,
            },
        }),
        settings: settingsOf(config),
        subscribers,
        pubsub,
        db,
    });

    return { ctx, devRoutes: dev.routes };
};

/**
 * Runs as a web node (`serve`), a job worker (`work`) or both (`all`) until SIGINT or SIGTERM, then
 * finishes the requests and jobs in progress. Returns the exit code.
 */
const run = async (role: string, config: Config): Promise<number> => {
    await using db = openDatabase(config.database);
    await using pubsub = pubSubFor(config, db);
    const { ctx, devRoutes } = contextFor(config, db, pubsub);

    const logger = getLogger(["verso"]);

    // Everything Verso sends is signed, so it can't do anything useful without its keys.
    try {
        await instanceKey(ctx);
        await vapidKey(ctx);
    } catch (error) {
        logger.fatal("{error}", { error: error instanceof Error ? error.message : error });
        return 1;
    }

    try {
        await ctx.files.check();
    } catch (error) {
        logger.fatal("Can't keep uploaded files: {error}", {
            error: error instanceof Error ? error.message : error,
        });
        return 1;
    }

    try {
        await ctx.images.check();
    } catch (error) {
        logger.fatal("Can't process pictures: {error}", {
            error: error instanceof Error ? error.message : error,
        });
        return 1;
    }

    const stopping = new AbortController();
    const stop = () => stopping.abort();
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) Deno.addSignalListener(signal, stop);

    // Every process caches the instance's key and blocked domains, so must hear when they change.
    forgetWhenTold(ctx);

    const worker = ctx.ids();

    await using wakeups = role === "serve" ? undefined : await listenForJobs(config.database);
    if (role !== "serve") {
        logger.info("Working on {queues} as {worker}", { queues: Object.keys(queues), worker });
    }

    await Promise.all([
        role === "work"
            ? undefined
            : serve(ctx, config, [...routes(config), ...devRoutes], stopping.signal),
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

    await using db = openDatabase(config.database, { forMigrations: true });
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

    const keyed = { db, clock: systemClock, ids: idGenerator(systemClock) };
    if (await ensureInstanceKey(keyed)) logger.info("Made the instance's key pair");
    if (await ensureVapidKey(keyed)) logger.info("Made the instance's key pair for Web Push");
    const indexed = await indexUnindexed(keyed);
    if (indexed > 0) logger.info("Indexed {count} statuses for search", { count: indexed });

    return 0;
};

/** Reads the config, or exits saying what is wrong with it. */
const configOrExit = async (path: string): Promise<Config> => {
    const result = await readConfig(path);
    if (result.ok) return result.config;

    // deno-lint-ignore no-console -- there is no logger before the config is read
    console.error(`Can't load ${path}:\n${result.error}`);
    Deno.exit(1);
};

/** Reads the config at `path` and sets up logging, before any command that needs them. */
const setUp = async (path: string): Promise<Config> => {
    const config = await configOrExit(path);
    await setUpLogging(config.logging.level);
    return config;
};

/** Runs `work` with the config at `path` and its context, for admin commands. */
const withContext = async <T>(
    path: string,
    work: (ctx: Context, config: Config) => Promise<T>,
): Promise<T> => {
    const config = await setUp(path);
    await using db = openDatabase(config.database);
    await using pubsub = pubSubFor(config, db);
    return await work(contextFor(config, db, pubsub).ctx, config);
};

const version = `verso ${denoConfig.version}`;

const cli = new Command()
    .name("verso")
    .version(denoConfig.version)
    .versionOption("-V, --version", "Show Verso's version.", {
        action: () => {
            // deno-lint-ignore no-console -- the version is command output, not a log line
            console.log(version);
            Deno.exit(0);
        },
    })
    .description("A Versia server, with a Mastodon-compatible API.")
    .globalOption("-c, --config <path:string>", "The config file.", { default: "config.toml" })
    .action(missingCommand)
    .command("serve", "Answer HTTP requests, until stopped.")
    .action(async ({ config }) => Deno.exit(await run("serve", await setUp(config))))
    .command(
        "work",
        "Run jobs, until stopped. Each worker runs as many jobs at once as its queues allow, " +
            "including per instance, so more workers send more to each instance at once.",
    )
    .action(async ({ config }) => Deno.exit(await run("work", await setUp(config))))
    .command("all", "Answer HTTP requests and run jobs, until stopped.")
    .action(async ({ config }) => Deno.exit(await run("all", await setUp(config))))
    .command("migrate", "Bring the database up to date, and make the instance's key pair.")
    .action(async ({ config }) => Deno.exit(await runMigrations(await setUp(config))))
    .command(
        "admin",
        adminCommand({
            withContext,
            // deno-lint-ignore no-console -- the result is command output, not a log line
            print: (line) => console.log(line),
        }),
    );

if (import.meta.main) {
    try {
        await cli.parse(Deno.args);
    } catch (error) {
        if (!(error instanceof AdminError)) throw error;

        // deno-lint-ignore no-console -- the failure is command output, not a log line
        console.error(error.message);
        Deno.exit(1);
    }
}
