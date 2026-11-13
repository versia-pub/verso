import { assertEquals } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createLocalAccount } from "./testing.ts";
import { webPreferenceRoutes } from "./web_preference_routes.ts";

const path = "/api/v1/web_preferences";

/** An instance with local users alice and bob. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, webPreferenceRoutes, { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");

    const call = async (
        method: "GET" | "PUT",
        options: { as?: string; scopes?: Scope[]; body?: string; ifMatch?: string } = {},
    ) => {
        const token = await tokenFor(
            test.ctx,
            options.as ?? "alice",
            options.scopes ?? ["read:accounts", "write:accounts"],
        );
        const headers = new Headers({ authorization: `Bearer ${token}` });
        if (options.body !== undefined) headers.set("content-type", "application/json");
        if (options.ifMatch !== undefined) headers.set("if-match", options.ifMatch);
        const response = await app.request(path, { method, headers, body: options.body });

        return {
            status: response.status,
            etag: response.headers.get("etag"),
            body: await response.json(),
        };
    };
    const get = async (as?: string) => await call("GET", { as });
    const put = async (json: unknown, ifMatch?: string) =>
        await call("PUT", { body: JSON.stringify(json), ifMatch });

    return { ...test, app, call, get, put };
};

Deno.test("a user has no web app settings until it saves some", async () => {
    await using test = await open();

    assertEquals(await test.get(), { status: 200, etag: '"0"', body: {} });
});

Deno.test("web app settings are read back as saved, each save with a new ETag", async () => {
    await using test = await open();
    const settings = { theme: "dark", columns: [{ timeline: "home" }], z: 1, a: "\u0000" };

    assertEquals(await test.put(settings), { status: 200, etag: '"1"', body: settings });
    assertEquals(await test.get(), { status: 200, etag: '"1"', body: settings });
    assertEquals(JSON.stringify((await test.get()).body), JSON.stringify(settings));

    assertEquals((await test.put({ theme: "light" })).etag, '"2"');
    assertEquals(await test.get(), { status: 200, etag: '"2"', body: { theme: "light" } });
});

Deno.test("each user has their own web app settings", async () => {
    await using test = await open();
    await test.put({ theme: "dark" });

    assertEquals(await test.get("bob"), { status: 200, etag: '"0"', body: {} });
});

Deno.test("a save with If-Match changes only the user's own settings", async () => {
    await using test = await open();
    await test.put({ theme: "dark" });
    await test.call("PUT", { as: "bob", body: JSON.stringify({ theme: "blue" }) });

    await test.put({ theme: "light" }, '"1"');

    assertEquals(await test.get("bob"), { status: 200, etag: '"1"', body: { theme: "blue" } });
});

Deno.test("web app settings are saved if If-Match names the current version", async () => {
    await using test = await open();

    assertEquals((await test.put({ n: 1 }, '"0"')).etag, '"1"');
    assertEquals((await test.put({ n: 2 }, '"1"')).etag, '"2"');
    assertEquals((await test.put({ n: 3 }, '"7", "2"')).etag, '"3"');
    assertEquals((await test.put({ n: 4 }, "*")).etag, '"4"');
    assertEquals(await test.get(), { status: 200, etag: '"4"', body: { n: 4 } });
});

Deno.test("a save with If-Match records when it was saved", async () => {
    await using test = await open();
    await test.put({ n: 1 });
    test.clock.advance(1000);

    await test.put({ n: 2 }, '"1"');

    const row = await test.ctx.db.selectFrom("web_preferences").select("updated_at")
        .executeTakeFirstOrThrow();
    assertEquals(row.updated_at, test.clock.now());
});

Deno.test("If-Match * saves a user's first web app settings", async () => {
    await using test = await open();

    assertEquals((await test.put({ n: 1 }, "*")).etag, '"1"');
});

Deno.test("web app settings aren't saved over a newer version", async () => {
    await using test = await open();
    await test.put({ n: 1 });
    await test.put({ n: 2 });

    for (const stale of ['"0"', '"1"', '"3"', 'W/"2"', "2", '"0", "1"', ""]) {
        const response = await test.put({ n: 3 }, stale);
        assertEquals(response.status, 412, stale);
        assertEquals(response.etag, null, stale);
    }

    assertEquals(await test.get(), { status: 200, etag: '"2"', body: { n: 2 } });
});

Deno.test("If-Match naming no version doesn't save a user's first settings", async () => {
    await using test = await open();

    assertEquals((await test.put({ n: 1 }, '"1"')).status, 412);
    assertEquals((await test.put({ n: 1 }, 'W/"0"')).status, 412);
    assertEquals((await test.put({ n: 1 }, '""')).status, 412);
    assertEquals(await test.get(), { status: 200, etag: '"0"', body: {} });
});

Deno.test("web app settings must be a JSON object", async () => {
    await using test = await open();

    for (const settings of [[1], "dark", 1, null]) {
        assertEquals((await test.put(settings)).status, 422, JSON.stringify(settings));
    }

    assertEquals((await test.get()).etag, '"0"');
});

Deno.test("web app settings may be up to 256 KiB", async () => {
    await using test = await open();
    const sized = (bytes: number) => ({ s: "x".repeat(bytes - '{"s":""}'.length) });

    assertEquals((await test.put(sized(256 * 1024))).status, 200);
    assertEquals((await test.put(sized(256 * 1024 + 1))).status, 413);
});

Deno.test("web app settings need a user's token that may read or write accounts", async () => {
    await using test = await open();
    const body = "{}";

    assertEquals((await test.call("GET", { scopes: ["read:accounts"] })).status, 200);
    assertEquals((await test.call("GET", { scopes: ["write:accounts"] })).status, 403);
    assertEquals((await test.call("PUT", { scopes: ["write:accounts"], body })).status, 200);
    assertEquals((await test.call("PUT", { scopes: ["read:accounts"], body })).status, 403);

    for (const method of ["GET", "PUT"]) {
        const response = await test.app.request(path, { method });
        await response.body?.cancel();

        assertEquals(response.status, 401, method);
    }
});

Deno.test("a user who moved may still read and save web app settings", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ moved_to_account_id: "bob", moved_at: test.clock.now() })
        .where("id", "=", "alice")
        .execute();

    assertEquals((await test.put({ n: 1 })).status, 200);
    assertEquals((await test.get()).body, { n: 1 });
});
