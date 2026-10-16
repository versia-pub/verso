import { html } from "@hono/hono/html";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { createTestContext } from "../kernel/testing.ts";
import { createApp } from "./app.ts";
import { NotFound } from "./errors.ts";
import { layout } from "./page.ts";
import { Binary, defineRoute, Page, Redirect } from "./route.ts";

const rename = defineRoute({
    method: "POST",
    path: "/things/:id",
    summary: "Renames a thing",
    params: z.object({ id: z.string() }),
    query: z.object({
        notify: z.coerce.number().int().max(1),
        tag: z.array(z.string()).optional(),
    }),
    body: z.object({ name: z.string().min(1), aliases: z.array(z.string()).optional() }),
    responses: {
        200: z.object({ id: z.string(), name: z.string(), tag: z.unknown(), aliases: z.unknown() }),
    },
    handler: (_, { params, query, body }) => {
        if (params.id === "missing") throw new NotFound();
        if (params.id === "broken") throw new Error("secret detail");

        return Promise.resolve({
            status: 200,
            body: { id: params.id, name: body.name, tag: query.tag, aliases: body.aliases },
        });
    },
});

/** Declares one shape and, typed loosely as data from elsewhere might be, sends another. */
const sloppy = defineRoute({
    method: "GET",
    path: "/sloppy",
    summary: "Replies with an undeclared shape",
    responses: { 200: z.object({ count: z.number() }) },
    handler: () => Promise.resolve({ status: 200, body: JSON.parse('{"count":"3"}') }),
});

const welcome = defineRoute({
    method: "GET",
    path: "/welcome",
    summary: "Greets someone, or sends them away",
    query: z.object({ name: z.string() }),
    responses: { 200: Page, 303: Redirect },
    handler: ({ urls }, { query }) =>
        Promise.resolve(
            query.name === "away"
                ? { status: 303, location: urls.url`/elsewhere` }
                : { status: 200, page: layout("Welcome", html`<p>Hello, ${query.name}</p>`) },
        ),
});

/** Remembers a visit in a cookie, and forgets it on the next one. */
const visit = defineRoute({
    method: "GET",
    path: "/visit",
    summary: "Counts visits in a cookie",
    cookies: z.object({ seen: z.string().optional() }),
    responses: { 200: z.object({ seen: z.boolean() }) },
    handler: (_, { cookies }) =>
        Promise.resolve({
            status: 200,
            body: { seen: cookies.seen !== undefined },
            cookies: { seen: cookies.seen === undefined ? "yes" : null },
        }),
});

const agent = defineRoute({
    method: "GET",
    path: "/agent",
    summary: "Names the client",
    headers: z.object({ "user-agent": z.string() }),
    responses: { 200: z.object({ agent: z.string() }) },
    handler: (_, { headers }) =>
        Promise.resolve({ status: 200, body: { agent: headers["user-agent"] } }),
});

/** Declares a page, and sends JSON. */
const notAPage = defineRoute({
    method: "GET",
    path: "/not-a-page",
    summary: "Replies with JSON instead of its page",
    responses: { 200: Page },
    handler: () => Promise.resolve({ status: 200, body: {} } as never),
});

const entity = defineRoute({
    method: "GET",
    path: "/entity",
    summary: "Replies with JSON of its own media type",
    tags: ["federation"],
    contentType: "application/vnd.versia+json; charset=utf-8",
    responses: { 200: z.object({ type: z.string() }) },
    handler: () => Promise.resolve({ status: 200, body: { type: "Note" } }),
});

/** A cacheable file, or an error: thrown for `missing`, replied for `gone`. */
const picture = defineRoute({
    method: "GET",
    path: "/pictures/:name",
    summary: "Sends a file anyone may cache",
    maxAge: 60,
    params: z.object({ name: z.string() }),
    responses: { 200: Binary("image/png"), 410: z.object({ error: z.string() }) },
    handler: (_, { params }) => {
        if (params.name === "missing") throw new NotFound();
        if (params.name === "gone") {
            return Promise.resolve({ status: 410, body: { error: "Gone" } });
        }

        return Promise.resolve({ status: 200, file: new Uint8Array([1, 2, 3]) });
    },
});

/** Declares a file, and sends JSON. */
const notAFile = defineRoute({
    method: "GET",
    path: "/not-a-file",
    summary: "Replies with JSON instead of its file",
    responses: { 200: Binary("image/png") },
    handler: () => Promise.resolve({ status: 200, body: {} } as never),
});

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, [
        rename,
        sloppy,
        welcome,
        visit,
        agent,
        notAPage,
        entity,
        picture,
        notAFile,
    ], {
        checkResponses: true,
    });

    const send = async (path: string, body: string, type = "application/json") => {
        const response = await app.request(path, {
            method: "POST",
            body,
            headers: { "content-type": type },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, send };
};

Deno.test("the liveness check answers ok", async () => {
    await using test = await open();
    const response = await test.app.request("/health/live");

    assertEquals(await response.text(), "ok");
});

Deno.test("a route gets its validated input and sends its reply", async () => {
    await using test = await open();
    assertEquals(await test.send("/things/a?notify=1&tag=x&tag=y", '{"name":"b"}'), {
        status: 200,
        body: { id: "a", name: "b", tag: ["x", "y"] },
    });
});

Deno.test("JSON is sent as the route's media type, or as application/json", async () => {
    await using test = await open();
    const entity = await test.app.request("/entity");
    const plain = await test.app.request("/agent", { headers: { "user-agent": "test" } });

    assertEquals(entity.headers.get("content-type"), "application/vnd.versia+json; charset=utf-8");
    assertEquals(await entity.json(), { type: "Note" });
    assertEquals(plain.headers.get("content-type"), "application/json");
    await plain.body?.cancel();
});

Deno.test("a query key[] is read as key, and is an array even when given once", async () => {
    await using test = await open();
    const tags = async (query: string) =>
        (await test.send(`/things/a?notify=1&${query}`, '{"name":"b"}')).body.tag;

    assertEquals(await tags("tag[]=x"), ["x"]);
    assertEquals(await tags("tag[]=x&tag[]=y"), ["x", "y"]);
    assertEquals(await tags("tag=x&tag[]=y"), ["x", "y"]);
    assertEquals(await tags("tag[]="), [""]);
});

Deno.test("invalid input is a 422 listing each problem by field path", async () => {
    await using test = await open();
    const { status, body } = await test.send("/things/a?notify=7", '{"name":""}');

    assertEquals(status, 422);
    assertEquals(body.error, "Validation failed");
    assertEquals(Object.keys(body.details).toSorted(), ["body.name", "query.notify"]);
});

Deno.test("a body can also be a form, with repeated or key[] fields as arrays", async () => {
    await using test = await open();
    const form = new FormData();
    form.append("name", "b");
    form.append("aliases", "c");
    form.append("aliases", "d");

    const multipart = await test.app.request("/things/a?notify=1", { method: "POST", body: form });
    const encoded = await test.send(
        "/things/a?notify=1",
        "name=b&aliases[]=c",
        "application/x-www-form-urlencoded",
    );

    assertEquals((await multipart.json()).aliases, ["c", "d"]);
    assertEquals(encoded.body.aliases, ["c"]);
});

Deno.test("a body must be well-formed JSON or form data", async () => {
    await using test = await open();
    assertEquals((await test.send("/things/a?notify=1", "name=b", "text/plain")).status, 415);
    assertEquals((await test.send("/things/a?notify=1", "{")).status, 400);
    assertEquals((await test.send("/things/a?notify=1", "--x", "multipart/form-data")).status, 400);
});

Deno.test("a body over 64 KiB is refused before it is read", async () => {
    await using test = await open();
    const atLimit = `"${"x".repeat(64 * 1024 - 2)}"`;

    const stated = await test.app.request("/things/a?notify=1", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "content-length": String(1024 ** 3) },
    });

    assertEquals(await test.send("/things/a?notify=1", `${atLimit} `), {
        status: 413,
        body: { error: "Content too large" },
    });
    assertEquals(stated.status, 413);
    assertEquals((await test.send("/things/a?notify=1", atLimit)).status, 422);
});

Deno.test("errors use Mastodon's shape, without internal details", async () => {
    await using test = await open();
    assertEquals(await test.send("/things/missing?notify=1", '{"name":"b"}'), {
        status: 404,
        body: { error: "Record not found" },
    });
    assertEquals(await test.send("/things/broken?notify=1", '{"name":"b"}'), {
        status: 500,
        body: { error: "Internal server error" },
    });

    assertEquals((await test.app.request("/nothing")).status, 404);
    assertEquals((await test.app.request("/things/a?notify=1")).status, 404);
});

Deno.test("with checks on, a reply that doesn't match its schema is a 500", async () => {
    await using test = await open();

    const response = await test.app.request("/sloppy");

    assertEquals(response.status, 500);
    assertEquals(await response.json(), { error: "Internal server error" });
});

Deno.test("a page is escaped HTML that other sites can't frame", async () => {
    await using test = await open();

    const response = await test.app.request("/welcome?name=<script>");

    assertEquals(response.headers.get("content-type"), "text/html; charset=UTF-8");
    assertEquals(response.headers.get("x-frame-options"), "DENY");
    assertStringIncludes(
        response.headers.get("content-security-policy") ?? "",
        "frame-ancestors 'none'",
    );
    assertStringIncludes(await response.text(), "<p>Hello, &lt;script&gt;</p>");
});

Deno.test("a redirect sends its location", async () => {
    await using test = await open();

    const response = await test.app.request("/welcome?name=away");

    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), "https://social.example/elsewhere");
});

Deno.test("cookies are host-only, secure and hidden from scripts", async () => {
    await using test = await open();

    const response = await test.app.request("/visit");

    assertEquals(await response.json(), { seen: false });
    assertEquals(
        response.headers.get("set-cookie"),
        "__Host-seen=yes; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
});

Deno.test("routes read only their own cookies, and can delete them", async () => {
    await using test = await open();
    const visit = (cookie: string) => test.app.request("/visit", { headers: { cookie } });

    const planted = await visit("seen=yes; __Secure-seen=yes; __Fake-seen=yes");
    const returning = await visit("__Host-seen=yes");

    assertEquals(await planted.json(), { seen: false });
    assertEquals(await returning.json(), { seen: true });
    assertStringIncludes(returning.headers.get("set-cookie") ?? "", "__Host-seen=; Max-Age=0");
});

Deno.test("routes read headers by lowercase name", async () => {
    await using test = await open();

    const named = await test.app.request("/agent", { headers: { "User-Agent": "Tusky" } });
    const missing = await test.app.request(new Request("http://localhost/agent"));

    assertEquals(await named.json(), { agent: "Tusky" });
    assertEquals((await missing.json()).details["headers.user-agent"] !== undefined, true);
});

Deno.test("nothing may cache a reply, an error or a check", async () => {
    await using test = await open();

    for (const path of ["/agent", "/missing", "/health/live", "/welcome?name=away"]) {
        const response = await test.app.request(path, { headers: { "user-agent": "Tusky" } });
        assertEquals(response.headers.get("cache-control"), "no-store", path);
    }
});

Deno.test("with checks on, JSON where a page or a file is declared is a 500", async () => {
    await using test = await open();

    assertEquals((await test.app.request("/not-a-page")).status, 500);
    assertEquals((await test.app.request("/not-a-file")).status, 500);
});

Deno.test("a file is sent as its declared type, and cached only when it is sent", async () => {
    await using test = await open();
    const sent = await test.app.request("/pictures/cat");
    const missing = await test.app.request("/pictures/missing");
    const gone = await test.app.request("/pictures/gone");
    await missing.body?.cancel();
    await gone.body?.cancel();

    assertEquals(sent.headers.get("content-type"), "image/png");
    assertEquals(sent.headers.get("cache-control"), "public, max-age=60");
    assertEquals([...new Uint8Array(await sent.arrayBuffer())], [1, 2, 3]);
    assertEquals(missing.headers.get("cache-control"), "no-store");
    assertEquals(gone.headers.get("cache-control"), "no-store");
});

Deno.test("with checks off, replies are sent as they are", async () => {
    await using test = await open();
    const app = createApp(test.ctx, [sloppy]);

    const response = await app.request("/sloppy");

    assertEquals(await response.json(), { count: "3" });
});

Deno.test("a handler can only reply with a declared status and body", () => {
    defineRoute({
        method: "GET",
        path: "/",
        summary: "Type checks only",
        responses: { 200: z.object({ ok: z.boolean() }) },
        // @ts-expect-error: 201 isn't declared
        handler: () => Promise.resolve({ status: 201, body: { ok: true } }),
    });

    defineRoute({
        method: "GET",
        path: "/",
        summary: "Type checks only",
        responses: { 200: z.object({ ok: z.boolean() }) },
        // @ts-expect-error: the body doesn't match the schema
        handler: () => Promise.resolve({ status: 200, body: { ok: "yes" } }),
    });

    defineRoute({
        method: "GET",
        path: "/",
        summary: "Type checks only",
        responses: { 200: Redirect },
        // @ts-expect-error: a redirect needs a redirect status
        handler: () => Promise.resolve({ status: 200, location: "/" }),
    });
});
