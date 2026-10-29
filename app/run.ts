/**
 * Running Verso: serving HTTP, working on jobs and migrating, with the context every command runs
 * with.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import type { Kysely } from "kysely";
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
import { indexUnindexedAccounts } from "./search/accounts.ts";
import { indexUnindexed } from "./search/notes.ts";
import { queues, tasks } from "./jobs/queues.ts";
import { runScheduler } from "./jobs/scheduler.ts";
import { listenForJobs } from "./jobs/wakeups.ts";
import { work } from "./jobs/worker.ts";
import { systemClock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { settingsOf } from "./kernel/settings.ts";
import { type Context, createContext, type PubSub } from "./kernel/context.ts";
import { filesFor } from "./kernel/file_stores.ts";
import { idGenerator } from "./kernel/ids.ts";
import { memoryPubSub } from "./kernel/pubsub.ts";
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
export const pubSubFor = (config: Config, db: Kysely<Database>): PubSub & AsyncDisposable =>
    "postgres" in config.database
        ? postgresPubSub(db, config.database.postgres)
        : { ...memoryPubSub(), [Symbol.asyncDispose]: () => Promise.resolve() };

/** The context every command runs with, and the development login's routes if it is on. */
export const contextFor = (
    config: Config,
    db: Kysely<Database>,
    pubsub: PubSub,
): { readonly ctx: Context; readonly devRoutes: readonly Route[] } => {
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

/** What a process runs as: a web node, a job worker, or both. */
export type Role = "serve" | "work" | "all";

/**
 * Runs as a web node (`serve`), a job worker (`work`) or both (`all`) until SIGINT or SIGTERM, then
 * finishes the requests and jobs in progress. Returns the exit code.
 */
export const run = async (role: Role, config: Config): Promise<number> => {
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
export const runMigrations = async (config: Config): Promise<number> => {
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
    const statuses = await indexUnindexed(keyed);
    if (statuses > 0) logger.info("Indexed {count} statuses for search", { count: statuses });
    const accounts = await indexUnindexedAccounts(keyed);
    if (accounts > 0) logger.info("Indexed {count} accounts for search", { count: accounts });

    return 0;
};
