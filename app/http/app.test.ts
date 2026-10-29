import { html } from "@hono/hono/html";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { createTestContext } from "../testing/context.ts";
import { createTestApp } from "../testing/app.ts";
import { NotFound } from "./errors.ts";
import { layout } from "./page.ts";
import { cursorsOf, PageQuery } from "./paging.ts";
import { defineRoute } from "./route.ts";
import { Binary, Linked, NoBody, Page, Paged, Redirect } from "./responses.ts";

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

const scripted = defineRoute({
    method: "GET",
    path: "/scripted",
    summary: "A page that runs a script from elsewhere",
    pagePolicy: "default-src 'none'; script-src https://cdn.example/",
    responses: { 200: Page },
    handler: () => Promise.resolve({ status: 200, page: layout("Scripted", html``) }),
});

/** Stores a visit in a cookie, and forgets it on the next one. */
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

/** A cacheable file, or an error: thrown for `missing`, returned for `gone`. */
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

/** Takes the request, to act on later. */
const later = defineRoute({
    method: "POST",
    path: "/later",
    summary: "Answers with no body",
    responses: { 202: NoBody },
    handler: () => Promise.resolve({ status: 202 }),
});

/** Declares no body, and sends JSON. */
const notEmpty = defineRoute({
    method: "GET",
    path: "/not-empty",
    summary: "Replies with JSON instead of nothing",
    responses: { 202: NoBody },
    handler: () => Promise.resolve({ status: 202, body: {} } as never),
});

const echo = defineRoute({
    method: "POST",
    path: "/echo",
    summary: "Answers with the body it was sent",
    body: z.record(z.string(), z.unknown()),
    responses: { 200: z.record(z.string(), z.unknown()) },
    handler: (_, { body }) => Promise.resolve({ status: 200, body }),
});

const echoText = defineRoute({
    method: "POST",
    path: "/echo-text",
    summary: "Answers with the text it was sent",
    textBody: true,
    body: z.string(),
    responses: { 200: z.object({ text: z.string() }) },
    handler: (_, { body }) => Promise.resolve({ status: 200, body: { text: body } }),
});

const echoLong = defineRoute({
    method: "POST",
    path: "/echo-long",
    summary: "Answers with how long the text it was sent is, of up to 300 KiB",
    textBody: true,
    maxBodyBytes: 300 * 1024,
    body: z.string(),
    responses: { 200: z.object({ length: z.int() }) },
    handler: (_, { body }) => Promise.resolve({ status: 200, body: { length: body.length } }),
});

const numbers = defineRoute({
    method: "GET",
    path: "/numbers",
    summary: "Counts down from 5, a page at a time",
    query: PageQuery({ default: 2, max: 3 }),
    responses: { 200: Paged(z.object({ n: z.number() })) },
    handler: (_, { query }) => {
        const items = [5, 4, 3, 2, 1]
            .filter((n) => query.max_id === undefined || n < Number(query.max_id))
            .slice(0, query.limit)
            .map((n) => ({ n }));

        return Promise.resolve({
            status: 200,
            body: items,
            cursors: cursorsOf(items, query, (item) => String(item.n)),
        });
    },
});

/** Counts down from 5 like {@link numbers}, but as the list in an object. */
const counted = defineRoute({
    method: "GET",
    path: "/counted",
    summary: "Counts down from 5, a page at a time, in an object",
    query: PageQuery({ default: 2, max: 3 }),
    responses: { 200: Linked(z.object({ numbers: z.array(z.number()) })) },
    handler: (_, { query }) => {
        const numbers = [5, 4, 3, 2, 1]
            .filter((n) => query.max_id === undefined || n < Number(query.max_id))
            .slice(0, query.limit);

        return Promise.resolve({
            status: 200,
            body: { numbers },
            cursors: cursorsOf(numbers, query, String),
        });
    },
});

/** Declares a page of a list in an object, and, typed loosely, sends no cursors. */
const uncountedObject = defineRoute({
    method: "GET",
    path: "/uncounted-object",
    summary: "Sends a list in an object without its cursors",
    responses: { 200: Linked(z.object({})) },
    handler: () => Promise.resolve(JSON.parse('{"status":200,"body":{}}')),
});

/**
 * Declares pages of a list, and, typed loosely as data from elsewhere might be, sends no cursors.
 */
const uncounted = defineRoute({
    method: "GET",
    path: "/uncounted",
    summary: "Sends a list without its cursors",
    responses: { 200: Paged(z.object({ n: z.number() })) },
    handler: () => Promise.resolve(JSON.parse('{"status":200,"body":[{"n":1}]}')),
});

/** Declares an object, and, typed loosely, sends cursors with it, as if it were a list. */
const overcounted = defineRoute({
    method: "GET",
    path: "/overcounted",
    summary: "Sends cursors with an object",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve(JSON.parse('{"status":200,"body":{},"cursors":{}}')),
});

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [
        rename,
        echo,
        echoText,
        echoLong,
        sloppy,
        welcome,
        scripted,
        visit,
        agent,
        notAPage,
        entity,
        picture,
        notAFile,
        later,
        notEmpty,
        numbers,
        counted,
        uncounted,
        uncountedObject,
        overcounted,
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

Deno.test("a form's Rails-style names are read as the JSON it stands for", async () => {
    await using test = await open();
    const form = [
        "source[privacy]=unlisted",
        "fields_attributes[0][name]=Site",
        "fields_attributes[0][value]=x",
        "fields_attributes[1][name]=Pronouns",
        "poll[options][]=yes",
        "poll[options][]=no",
    ].join("&");

    assertEquals(await test.send("/echo", form, "application/x-www-form-urlencoded"), {
        status: 200,
        body: {
            source: { privacy: "unlisted" },
            fields_attributes: [{ name: "Site", value: "x" }, { name: "Pronouns" }],
            poll: { options: ["yes", "no"] },
        },
    });
});

Deno.test("form names can't reach prototypes or nest without end", async () => {
    await using test = await open();
    const send = (form: string) => test.send("/echo", form, "application/x-www-form-urlencoded");

    const sneaky = await send("__proto__[admin]=1&constructor[prototype][admin]=1&a=b");
    assertEquals(sneaky, { status: 200, body: { a: "b" } });
    assertEquals(Reflect.get({}, "admin"), undefined);

    assertEquals((await send("a[b][c][d][e][f]=1")).status, 200);
    assertEquals((await send("a[b][c][d][e][f][g]=1")).status, 400);
});

Deno.test("a form's files must have plain names", async () => {
    await using test = await open();
    const post = (name: string, times = 1) => {
        const form = new FormData();
        for (let i = 0; i < times; i++) form.append(name, new File(["x"], "x.png"));
        return test.app.request("/echo", { method: "POST", body: form });
    };

    const plain = await post("avatar");
    assertEquals([plain.status, Object.keys(await plain.json())], [200, ["avatar"]]);

    for (const [name, times] of [["avatar[0]", 1], ["avatars[]", 1], ["avatar", 2]] as const) {
        const refused = await post(name, times);
        assertEquals(
            [refused.status, (await refused.json()).error_description],
            [400, `A file must have a plain name, used once, unlike "${name}"`],
        );
    }
});

Deno.test("a body must be well-formed JSON or form data", async () => {
    await using test = await open();
    assertEquals((await test.send("/things/a?notify=1", "name=b", "text/plain")).status, 415);
    assertEquals((await test.send("/things/a?notify=1", "{")).status, 400);
    assertEquals((await test.send("/things/a?notify=1", "--x", "multipart/form-data")).status, 400);
});

Deno.test("a missing or empty body is read as an empty one, of any type", async () => {
    await using test = await open();

    const missing = await test.app.request("/echo", { method: "POST" });
    assertEquals([missing.status, await missing.json()], [200, {}]);

    // As Deno's server gives a request with no body.
    const served = await test.app.request("/echo", { method: "POST", body: new Uint8Array() });
    assertEquals([served.status, await served.json()], [200, {}]);
    const untyped = await test.app.request("/echo", {
        method: "POST",
        body: new TextEncoder().encode("{}"),
    });
    assertEquals(untyped.status, 415);

    assertEquals(await test.send("/echo", ""), { status: 200, body: {} });
    assertEquals(await test.send("/echo", "", "application/x-www-form-urlencoded"), {
        status: 200,
        body: {},
    });
    assertEquals((await test.send("/echo", "", "text/plain")).status, 415);
    assertEquals((await test.send("/echo", " ")).status, 400);
});

Deno.test("a route that takes plain text reads it as it was sent, and only that", async () => {
    await using test = await open();

    assertEquals(await test.send("/echo-text", '{"a": 1}\n', "text/plain; charset=utf-8"), {
        status: 200,
        body: { text: '{"a": 1}\n' },
    });
    assertEquals((await test.send("/echo-text", "{}")).status, 415);
    assertEquals(
        (await test.send("/echo-text", "a=b", "application/x-www-form-urlencoded")).status,
        415,
    );

    // A missing or empty body is an empty one.
    const missing = await test.app.request("/echo-text", { method: "POST" });
    assertEquals([missing.status, await missing.json()], [200, { text: "" }]);
    assertEquals(await test.send("/echo-text", ""), { status: 200, body: { text: "" } });
});

Deno.test("a body over 256 KiB is refused before it is read", async () => {
    await using test = await open();
    const atLimit = `"${"x".repeat(256 * 1024 - 2)}"`;

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

Deno.test("a route can take a larger body, up to a limit of its own", async () => {
    await using test = await open();
    const text = (length: number) => "x".repeat(length);

    assertEquals(await test.send("/echo-long", text(300 * 1024), "text/plain"), {
        status: 200,
        body: { length: 300 * 1024 },
    });
    assertEquals((await test.send("/echo-long", text(300 * 1024 + 1), "text/plain")).status, 413);
    assertEquals((await test.send("/echo-text", text(256 * 1024 + 1), "text/plain")).status, 413);
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
    assertEquals(
        response.headers.get("content-security-policy"),
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    assertStringIncludes(await response.text(), "<p>Hello, &lt;script&gt;</p>");
});

Deno.test("a page may load what its route allows, but still can't be framed", async () => {
    await using test = await open();

    const response = await test.app.request("/scripted");

    assertEquals(response.headers.get("x-frame-options"), "DENY");
    assertEquals(
        response.headers.get("content-security-policy"),
        "default-src 'none'; script-src https://cdn.example/; frame-ancestors 'none'",
    );
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

Deno.test("with checks on, JSON where a page, a file or nothing is declared is a 500", async () => {
    await using test = await open();

    assertEquals((await test.app.request("/not-a-page")).status, 500);
    assertEquals((await test.app.request("/not-a-file")).status, 500);
    assertEquals((await test.app.request("/not-empty")).status, 500);
});

Deno.test("a page of a list links to the pages around it, at the instance's own origin", async () => {
    await using test = await open();

    const first = await test.app.request("http://localhost/numbers?limit=2&extra=1");
    assertEquals(await first.json(), [{ n: 5 }, { n: 4 }]);
    assertEquals(
        first.headers.get("link"),
        '<https://social.example/numbers?limit=2&extra=1&max_id=4>; rel="next", ' +
            '<https://social.example/numbers?limit=2&extra=1&min_id=5>; rel="prev"',
    );

    const last = await test.app.request("/numbers?max_id=2");
    assertEquals(await last.json(), [{ n: 1 }]);
    assertEquals(last.headers.get("link"), '<https://social.example/numbers?min_id=1>; rel="prev"');

    const none = await test.app.request("/numbers?max_id=1");
    assertEquals([await none.json(), none.headers.get("link")], [[], null]);
});

Deno.test("a page of a list in an object links to the pages around it too", async () => {
    await using test = await open();

    const first = await test.app.request("/counted?limit=2");
    assertEquals(await first.json(), { numbers: [5, 4] });
    assertEquals(
        first.headers.get("link"),
        '<https://social.example/counted?limit=2&max_id=4>; rel="next", ' +
            '<https://social.example/counted?limit=2&min_id=5>; rel="prev"',
    );
});

Deno.test("with checks on, a list without cursors, or cursors without a list, is a 500", async () => {
    await using test = await open();

    assertEquals((await test.app.request("/uncounted")).status, 500);
    assertEquals((await test.app.request("/uncounted-object")).status, 500);
    assertEquals((await test.app.request("/overcounted")).status, 500);
});

Deno.test("a reply with no body is sent empty, with no type", async () => {
    await using test = await open();
    const response = await test.app.request("/later", { method: "POST" });

    assertEquals(response.status, 202);
    assertEquals(response.headers.get("content-type"), null);
    assertEquals(await response.text(), "");
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
    const app = createTestApp(test.ctx, [sloppy]);

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
