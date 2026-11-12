import { assert, assertEquals } from "@std/assert";
import { devLogin } from "../auth/dev_login.ts";
import { defaultSettings } from "../instances/testing.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import { memoryRateLimitStore } from "./rate_limits.ts";
import { routes } from "./routes.ts";
import { isReserved, loadWebApp, opensWebApp, reservedPaths } from "./web.ts";

/** A page like SvelteKit's: inline scripts to hash, and one loaded from a file, which isn't. */
const page = `<!doctype html>
<html>
    <head><script type="module" src="/_web/immutable/entry/app.js"></script></head>
    <body><script>start()</script><script>go()</script></body>
</html>
`;

/** The hashes of `start()` and `go()`, worked out with `openssl dgst -sha256 -binary | base64`. */
const startHash = "'sha256-DIm7WJS6ZKDYe5qFLPy+h4JFI9Bol5QmYC57mt3Fb00='";
const goHash = "'sha256-5KYv+PUboo5h+0+YAtGRPbwv5d/QxzHslP4YGnUaxRw='";

/** A built web app in a temporary directory, removed when disposed. */
const builtApp = async () => {
    const dir = await Deno.makeTempDir();
    await Deno.mkdir(`${dir}/_web/immutable/entry`, { recursive: true });
    await Deno.writeTextFile(`${dir}/index.html`, page);
    await Deno.writeTextFile(`${dir}/_web/immutable/entry/app.js`, "start = () => {};");
    await Deno.writeTextFile(`${dir}/_web/version.json`, '{"version":"1"}');

    return {
        root: new URL(`file://${dir}/`),
        [Symbol.asyncDispose]: () => Deno.remove(dir, { recursive: true }),
    };
};

/**
 * An app serving the built web app, and the response to a request for `path`. A limited app allows
 * one request every 30 seconds.
 */
const open = async (options: { readonly built?: boolean; readonly limited?: boolean } = {}) => {
    const test = await createTestContext();
    const build = await builtApp();
    const web = options.built === false ? undefined : await loadWebApp(build.root);
    const policy = { limit: 1, windowSeconds: 30 };
    const rateLimits = options.limited
        ? { store: memoryRateLimitStore(test.clock), policy, instancePolicy: policy }
        : undefined;
    const app = createTestApp(test.ctx, routes(defaultSettings()), { web, rateLimits });

    const request = async (path: string, init: RequestInit = {}, peer = "203.0.113.9") => {
        const response = await app.request(path, init, { remoteAddr: { hostname: peer } });
        const body = await response.text();
        return { status: response.status, headers: response.headers, body };
    };

    return {
        ...test,
        request,
        [Symbol.asyncDispose]: async () => {
            await build[Symbol.asyncDispose]();
            await test[Symbol.asyncDispose]();
        },
    };
};

const browser = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

Deno.test("a built web app is read with its files' types and its inline scripts' hashes", async () => {
    await using build = await builtApp();

    const web = await loadWebApp(build.root);

    assert(web);
    assertEquals(new TextDecoder().decode(web.page), page);
    assertEquals([...web.files.keys()].sort(), [
        "/_web/immutable/entry/app.js",
        "/_web/version.json",
    ]);
    assertEquals(
        web.files.get("/_web/immutable/entry/app.js")?.type,
        "text/javascript; charset=utf-8",
    );
    assertEquals(web.files.get("/_web/version.json")?.type, "application/json");
    assertEquals(
        web.policy,
        `default-src 'none'; script-src 'self' ${startHash} ${goHash}; ` +
            "style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; " +
            "form-action 'self'",
    );
});

Deno.test("a web app that isn't built is nothing", async () => {
    const dir = await Deno.makeTempDir();

    try {
        assertEquals(await loadWebApp(new URL(`file://${dir}/missing/`)), undefined);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("a browser gets the web app's page at an address no route serves", async () => {
    await using test = await open();

    for (const path of ["/", "/@alice", "/tags/cats", "/apiary", "/oauth/web-callback"]) {
        const response = await test.request(path, { headers: browser });

        assertEquals(response.status, 200, path);
        assertEquals(response.body, page);
        assertEquals(response.headers.get("content-type"), "text/html; charset=utf-8");
        assertEquals(response.headers.get("cache-control"), "no-cache");
        assertEquals(response.headers.get("vary"), "accept");
    }
});

Deno.test("the web app's page may run its own scripts and nothing else, and can't be framed", async () => {
    await using test = await open();

    const response = await test.request("/", { headers: browser });

    const policy = response.headers.get("content-security-policy") ?? "";
    assert(policy.startsWith("default-src 'none'; script-src 'self' "), policy);
    assert(policy.includes(startHash), policy);
    assert(policy.endsWith("; frame-ancestors 'none'"), policy);
    assertEquals(response.headers.get("x-frame-options"), "DENY");
});

Deno.test("a HEAD request for a page gets its headers", async () => {
    await using test = await open();

    const response = await test.request("/@alice", { method: "HEAD", headers: browser });

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("an address no route serves is still a 404 for anything but a browser opening it", async () => {
    await using test = await open();

    const cases: [string, RequestInit][] = [
        ["/@alice", {}],
        ["/@alice", { headers: { accept: "application/json" } }],
        ["/@alice", { method: "POST", headers: browser }],
        ["/api/v1/nothing", { headers: browser }],
        ["/api", { headers: browser }],
        ["/oauth/web-callback/more", { headers: browser }],
        ["/oauth/nothing", { headers: browser }],
        ["/_web/immutable/missing.js", { headers: browser }],
    ];
    for (const [path, init] of cases) {
        const response = await test.request(path, init);

        assertEquals(response.status, 404, `${init.method ?? "GET"} ${path}`);
        assertEquals(JSON.parse(response.body), { error: "Record not found" });
    }
});

Deno.test("without a built web app, every address no route serves is a 404", async () => {
    await using test = await open({ built: false });

    const response = await test.request("/", { headers: browser });

    assertEquals(response.status, 404);
});

Deno.test("the web app's files are served with their types, and cached if they never change", async () => {
    await using test = await open();

    const script = await test.request("/_web/immutable/entry/app.js");
    const version = await test.request("/_web/version.json");

    assertEquals(script.status, 200);
    assertEquals(script.body, "start = () => {};");
    assertEquals(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals(script.headers.get("cache-control"), "public, max-age=31536000, immutable");

    assertEquals(version.status, 200);
    assertEquals(version.body, '{"version":"1"}');
    assertEquals(version.headers.get("content-type"), "application/json");
    assertEquals(version.headers.get("cache-control"), "no-cache");
});

Deno.test("the web app's files are limited apart from other requests, which pages count as", async () => {
    await using test = await open({ limited: true });
    const script = () => test.request("/_web/immutable/entry/app.js");

    for (let i = 0; i < 10; i++) assertEquals((await script()).status, 200);
    assertEquals((await script()).status, 429);

    assertEquals((await test.request("/", { headers: browser })).status, 200);
    assertEquals((await test.request("/", { headers: browser })).status, 429);
});

Deno.test("reserved paths match whole segments", () => {
    assert(isReserved("/api"));
    assert(isReserved("/api/v1/accounts"));
    assert(!isReserved("/apiary"));
    assert(!isReserved("/"));
    assert(opensWebApp("GET", "/oauth/web-callback", "text/html"));
    assert(!opensWebApp("GET", "/oauth/authorize", "text/html"));
});

Deno.test("every route is under a reserved path, so the web app never takes its addresses", () => {
    const dev = devLogin(true, urlBuilder("social.example"));
    const all = [...routes(defaultSettings()), ...dev.routes];

    const outside = all.map((route) => route.path).filter((path) => !isReserved(path));

    assertEquals(outside, []);
    assert(reservedPaths.includes("/_web"));
});
