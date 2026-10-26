import { parse } from "@std/toml";
import { z } from "zod";
import { CidrText } from "./ip.ts";
import { interpolate, type Sources, systemSources } from "./interpolate.ts";
import {
    DomainName,
    FileStorage,
    Instance,
    Issuer,
    Limits,
    MediaLimits,
    Origin,
    Permissions,
} from "./config_sections.ts";

const developmentOnly = 'Only allowed with mode = "development"';

/**
 * Whether browsers keep `__Host-` cookies set by the origin, which needs https, or a local host
 * they trust without it.
 */
const keepsCookies = (origin: string) => {
    const { protocol, hostname } = new URL(origin);
    return protocol === "https:" || hostname === "localhost" || hostname.endsWith(".localhost") ||
        hostname === "127.0.0.1";
};

/**
 * Everything an instance can be configured with. Unknown keys are errors, so typos don't go
 * unnoticed.
 */
export const Config = z.strictObject({
    /**
     * `development` allows settings that are unsafe on a public server, for running Verso locally.
     */
    mode: z.enum(["production", "development"]).default("production"),
    /**
     * The instance's domain, without a port.
     * @see https://versia.pub/api/basics#domain
     */
    domain: z.hostname().transform((domain) => domain.toLowerCase()),
    /** Exactly one of a libpq connection string for PostgreSQL, or the path of a SQLite file. */
    database: z.union([
        z.strictObject({
            postgres: z.string().min(1),
            /**
             * How many connections each process may have open. The default leaves room for every
             * queue's jobs at once, and the requests of a web node beside them.
             */
            pool_size: z.int().min(1).default(30),
            /** How long to wait for a connection, from the pool or to the server. */
            connect_timeout_seconds: z.int().min(1).default(10),
            /**
             * How long a query may run, and a transaction wait between queries, before Postgres
             * ends it, so one stuck can't hold its locks and connection; 0 for no limit. It doesn't
             * apply to migrations.
             */
            statement_timeout_seconds: z.int().min(0).default(60),
        }),
        z.strictObject({ sqlite: z.string().min(1) }),
    ], { error: 'Set exactly one of "postgres" or "sqlite"' }),
    http: z.strictObject({
        port: z.int().min(1).max(65535).default(8080),
        /**
         * Where the instance is reached, if not at `https://<domain>`, such as
         * `http://localhost:8080`. Development only.
         */
        origin: Origin.optional(),
        /**
         * The reverse proxies in front of Verso, as addresses or CIDR ranges such as
         * `127.0.0.1` or `10.0.0.0/8`. Only these are believed about who the client is.
         */
        trusted_proxies: z.array(CidrText).default([]),
        /**
         * How many requests each client may make in a window of time, as in Mastodon: per access
         * token, or per IP address without a valid one.
         */
        rate_limit: z.strictObject({
            limit: z.int().min(1).default(300),
            window_seconds: z.int().min(1).default(300),
            /**
             * Where counts are kept: in each server's memory, or in the database, so that several
             * web nodes share them. The database costs a write per request.
             */
            store: z.enum(["memory", "database"]).default("memory"),
        }).prefault({}),
    }).prefault({}),
    auth: z.strictObject({
        /** Without any, the server runs but nobody can log in. */
        issuers: z.array(Issuer).default([]).refine(
            (issuers) => new Set(issuers.map((issuer) => issuer.url)).size === issuers.length,
            { error: "Each issuer URL can only be listed once" },
        ),
        /** A form that logs in as any username, with no password. Development only. */
        dev_login: z.boolean().default(false),
        /** How long a request to an issuer may take before the login is given up on. */
        timeout_seconds: z.int().min(1).default(15),
    }).prefault({}),
    federation: z.strictObject({
        /**
         * Lets Verso send requests to other instances at internal addresses, such as ones on a
         * local network or this machine. Development only, since anyone can name an instance.
         */
        allow_internal_addresses: z.boolean().default(false),
        /**
         * Instances Verso doesn't federate with, with their subdomains, besides the ones blocked
         * with `verso admin domains block`.
         */
        blocked_domains: z.array(DomainName).default([]),
        /**
         * Answers blocked instances as if nothing were wrong, so they can't tell they're blocked,
         * rather than with a 403 that says why: what they fetch isn't found, and what they send is
         * accepted, so they don't send it again.
         */
        silent_blocks: z.boolean().default(false),
        /**
         * How many days an instance can go unreached before Verso stops sending it anything, until
         * it hears from it again. A week by default, as on Mastodon.
         */
        unreachable_days: z.int().min(1).default(7),
        /**
         * How many requests each instance may send in a window of time, counted by who signed
         * them, apart from clients' limit. Requests that aren't validly signed count against their
         * client instead.
         */
        rate_limit: z.strictObject({
            limit: z.int().min(1).default(3000),
            window_seconds: z.int().min(1).default(300),
        }).prefault({}),
        /**
         * How many fetches each process makes from one instance in a window of time, so that what
         * other instances send can't make Verso flood one. Fetches past it are left for later.
         */
        fetch_limit: z.strictObject({
            limit: z.int().min(1).default(600),
            window_seconds: z.int().min(1).default(300),
        }).prefault({}),
    }).prefault({}),
    media: MediaLimits.extend({
        /** Where uploaded files are kept. */
        storage: FileStorage,
    }),
    instance: Instance,
    limits: Limits,
    permissions: Permissions,
    jobs: z.strictObject({
        /** How many days a job that failed for good is kept, for someone to look at. */
        dead_letter_days: z.int().min(1).default(30),
    }).prefault({}),
    logging: z.strictObject({
        level: z.enum(["trace", "debug", "info", "warning", "error", "fatal"])
            .default("info"),
    }).prefault({}),
}).superRefine((config, ctx) => {
    if (config.mode === "production" && config.http.origin !== undefined) {
        ctx.addIssue({ code: "custom", path: ["http", "origin"], message: developmentOnly });
    }

    if (config.mode === "production" && config.auth.dev_login) {
        ctx.addIssue({ code: "custom", path: ["auth", "dev_login"], message: developmentOnly });
    }

    if (config.mode === "production" && config.federation.allow_internal_addresses) {
        ctx.addIssue({
            code: "custom",
            path: ["federation", "allow_internal_addresses"],
            message: developmentOnly,
        });
    }

    if (
        config.http.origin !== undefined && new URL(config.http.origin).hostname !== config.domain
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["http", "origin"],
            message: "Must be on the domain",
        });
    }

    if (config.http.origin !== undefined && !keepsCookies(config.http.origin)) {
        ctx.addIssue({
            code: "custom",
            path: ["http", "origin"],
            message: "Must be https, or http on localhost, for browsers to keep the login cookie",
        });
    }
});

export type Config = z.infer<typeof Config>;

export type ConfigResult =
    | { readonly ok: true; readonly config: Config }
    | { readonly ok: false; readonly error: string };

/**
 * Parses and checks the text of a TOML config file, after filling in its `${env:…}` and
 * `${file:…}` references from `sources`.
 */
export const parseConfig = async (
    toml: string,
    sources: Sources = systemSources,
): Promise<ConfigResult> => {
    let data: unknown;
    try {
        data = parse(toml);
    } catch (error) {
        return {
            ok: false,
            error: `Invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    const filled = await interpolate(data, sources);
    if (!filled.ok) return filled;

    const result = Config.safeParse(filled.data);
    return result.success
        ? { ok: true, config: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
};

/** Reads the config file at `path`. */
export const readConfig = async (
    path: string,
    sources: Sources = systemSources,
): Promise<ConfigResult> => {
    let text: string;
    try {
        text = await Deno.readTextFile(path);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return await parseConfig(text, sources);
};
