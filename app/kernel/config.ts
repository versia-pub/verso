import { parse } from "@std/toml";
import { z } from "zod";
import { Permission } from "../accounts/permissions.ts";
import { CidrText } from "./ip.ts";
import { interpolate, type Sources, systemSources } from "./interpolate.ts";

/**
 * Who may get an account on first login with an issuer: anyone (`open`), nobody (`closed`, so only
 * identities an admin linked), or anyone whose ID token claim contains a value, such as
 * `{ claim = "groups", contains = "versia-users" }`.
 */
const Registration = z.union([
    z.enum(["open", "closed"]),
    z.strictObject({ claim: z.string().min(1), contains: z.string().min(1) }),
]);

/** An OpenID Connect provider users log in with. Verso is a client registered with it. */
const Issuer = z.strictObject({
    /** Shown on the login page when there is more than one issuer. */
    name: z.string().min(1),
    /** The issuer's URL. Accounts are linked to it, so changing it unlinks them all. */
    url: z.url({ protocol: /^https$/, error: "Must be an https URL" }),
    client_id: z.string().min(1),
    /** Keep it out of the config file with a reference, such as `${file:/run/secrets/oidc}`. */
    client_secret: z.string().min(1),
    /** The claim a new account's username comes from. */
    username_claim: z.string().min(1).default("preferred_username"),
    registration: Registration.default("closed"),
});

/** An origin with no path, such as `http://localhost:8080`. */
const Origin = z.url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).origin === url.replace(/\/$/, ""), {
        error: "Must be an origin, such as http://localhost:8080, with no path",
    })
    .transform((url) => new URL(url).origin);

/** How long and how many of what users write may be, in characters, counted by code point. */
export const Limits = z.strictObject({
    display_name: z.int().min(1).default(60),
    /** The bio. */
    note: z.int().min(1).default(10_000),
    /** How many profile fields an account may have. */
    fields: z.int().min(0).default(16),
    field_name: z.int().min(1).default(255),
    field_value: z.int().min(1).default(255),
}).prefault({});
export type Limits = z.infer<typeof Limits>;

/** What everyone may do, before any role adds more. */
export const Permissions = z.strictObject({
    /** For requests without a user, such as a logged-out visitor's. */
    anonymous: z.array(Permission).default(["read:account"]),
    /** For every user. */
    default: z.array(Permission).default(["read:account", "owner:account"]),
}).prefault({});
export type Permissions = z.infer<typeof Permissions>;

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
        z.strictObject({ postgres: z.string().min(1) }),
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
    }).prefault({}),
    limits: Limits,
    permissions: Permissions,
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
            error: `Invalid TOML: ${(error as Error).message}`,
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
        return { ok: false, error: (error as Error).message };
    }

    return await parseConfig(text, sources);
};
