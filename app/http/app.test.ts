import { assertEquals } from "@std/assert";
import { z } from "zod";
import { createTestContext } from "../kernel/testing.ts";
import { createApp } from "./app.ts";
import { NotFound } from "./errors.ts";
import { defineRoute } from "./route.ts";

const rename = defineRoute({
    method: "POST",
    path: "/things/:id",
    summary: "Renames a thing",
    params: z.object({ id: z.string() }),
    query: z.object({
        notify: z.coerce.number().int().max(1),
        tag: z.array(z.string()).optional(),
    }),
    body: z.object({ name: z.string().min(1) }),
    responses: { 200: z.object({ id: z.string(), name: z.string(), tag: z.unknown() }) },
    handler: (_, { params, query, body }) => {
        if (params.id === "missing") throw new NotFound();
        if (params.id === "broken") throw new Error("secret detail");

        return Promise.resolve({
            status: 200,
            body: { id: params.id, name: body.name, tag: query.tag },
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

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, [rename, sloppy], { checkResponses: true });

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

Deno.test("invalid input is a 422 listing each problem by field path", async () => {
    await using test = await open();
    const { status, body } = await test.send("/things/a?notify=7", '{"name":""}');

    assertEquals(status, 422);
    assertEquals(body.error, "Validation failed");
    assertEquals(Object.keys(body.details).toSorted(), ["body.name", "query.notify"]);
});

Deno.test("a body must be well-formed JSON", async () => {
    await using test = await open();
    assertEquals((await test.send("/things/a?notify=1", "name=b", "text/plain")).status, 415);
    assertEquals((await test.send("/things/a?notify=1", "{")).status, 400);
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
});
