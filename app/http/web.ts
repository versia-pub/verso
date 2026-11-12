/**
 * The web app, built from `packages/web`: its files under `/_web/`, and the page that starts it,
 * which browsers get at any address no route serves.
 * @module
 */
import { getMimeType } from "@hono/hono/utils/mime";

/** One of the web app's files. */
export type WebFile = { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string };

/** The built web app, read once at startup. */
export type WebApp = {
    /** The files under `/_web/`, by path, such as `/_web/version.json`. */
    readonly files: ReadonlyMap<string, WebFile>;
    /** The page that starts the app. */
    readonly page: Uint8Array<ArrayBuffer>;
    /** What the page may load and run, as a Content-Security-Policy. */
    readonly policy: string;
};

/** Where the web app's files are served from. */
export const webPrefix = "/_web/";

/**
 * Where browsers land after logging in to the web app, as the seeded app's redirect URI. It is
 * under `/oauth`, so it is the one reserved path that gets the page.
 */
export const webCallbackPath = "/oauth/web-callback";

/**
 * Paths that only routes serve, so a browser opening an address under one that no route serves
 * gets a 404, not the web app.
 */
export const reservedPaths: readonly string[] = [
    "/.versia",
    "/.well-known",
    "/_web",
    "/accounts",
    "/api",
    "/docs",
    "/health",
    "/instance",
    "/media",
    "/metrics",
    "/nodeinfo",
    "/oauth",
    "/openapi.json",
];

/** Whether `path` is one of `reservedPaths` or under one. */
export const isReserved = (path: string): boolean =>
    reservedPaths.some((reserved) => path === reserved || path.startsWith(`${reserved}/`));

/** Whether a request for `path` with `method` and `accept` should get the web app's page. */
export const opensWebApp = (method: string, path: string, accept: string): boolean =>
    (method === "GET" || method === "HEAD") &&
    accept.includes("text/html") &&
    (path === webCallbackPath || !isReserved(path));

/** The `'sha256-…'` source that allows the inline script `source`. */
const scriptHash = async (source: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return `'sha256-${new Uint8Array(digest).toBase64()}'`;
};

/**
 * What the page may load and run: its own files, and the inline script SvelteKit starts the app
 * with. Styles may be inline, as Svelte's transitions add them.
 */
export const pagePolicy = async (page: string): Promise<string> => {
    const inline = [...page.matchAll(/<script>([^]*?)<\/script>/g)].map((match) => match[1] ?? "");
    const hashes = await Promise.all(inline.map(scriptHash));

    return [
        "default-src 'none'",
        ["script-src 'self'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
    ].join("; ");
};

/** Every file under `dir`, by its path from `dir`, such as `immutable/entry/app.js`. */
const filesUnder = async function* (dir: URL, prefix = ""): AsyncGenerator<string> {
    for await (const entry of Deno.readDir(dir)) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory) yield* filesUnder(new URL(`${entry.name}/`, dir), `${path}/`);
        else if (entry.isFile) yield path;
    }
};

/**
 * Reads the web app built into `root`, which ends in `/`, or nothing if it isn't built. Its files
 * are kept in memory, so serving one never touches the disk.
 */
export const loadWebApp = async (root: URL): Promise<WebApp | undefined> => {
    let page;
    try {
        page = await Deno.readFile(new URL("index.html", root));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
    }

    const dir = new URL(webPrefix.slice(1), root);
    const files = new Map<string, WebFile>();
    for await (const path of filesUnder(dir)) {
        const bytes = await Deno.readFile(new URL(path, dir));
        files.set(`${webPrefix}${path}`, {
            bytes,
            type: getMimeType(path) ?? "application/octet-stream",
        });
    }

    return { files, page, policy: await pagePolicy(new TextDecoder().decode(page)) };
};
