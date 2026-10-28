import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { markerRoutes } from "./routes.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, markerRoutes, { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const request = async (
        method: string,
        path: string,
        options: { as?: string; scopes?: Scope[]; body?: unknown; form?: string } = {},
    ) => {
        const token = await tokenFor(test.ctx, options.as ?? "alice", options.scopes);
        const response = await app.request(path, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(options.body !== undefined && { "content-type": "application/json" }),
                ...(options.form !== undefined &&
                    { "content-type": "application/x-www-form-urlencoded" }),
            },
            body: options.form ??
                (options.body === undefined ? undefined : JSON.stringify(options.body)),
        });

        return { status: response.status, body: await response.json() };
    };

    /** The markers at `query`, each as its last read id and version. */
    const markers = async (query: string, as?: string) => {
        const { status, body } = await request("GET", `/api/v1/markers${query}`, { as });
        assertEquals(status, 200);

        return Object.fromEntries(
            Object.entries(body as Record<string, { last_read_id: string; version: number }>)
                .map(([timeline, marker]) => [timeline, [marker.last_read_id, marker.version]]),
        );
    };

    return { ...test, request, markers };
};

Deno.test("markers are saved, a version on each time, and read for the timelines asked for", async () => {
    await using test = await open();
    const both = "?timeline[]=home&timeline[]=notifications";
    assertEquals(await test.markers(both), {});

    const saved = await test.request("POST", "/api/v1/markers", {
        body: { home: { last_read_id: "a" } },
    });
    assertEquals(saved.status, 200);
    assertEquals(saved.body, {
        home: { last_read_id: "a", version: 1, updated_at: test.clock.now().toISOString() },
    });

    test.clock.advance(1000);
    const again = await test.request("POST", "/api/v1/markers", {
        body: { home: { last_read_id: "b" }, notifications: { last_read_id: "c" } },
    });
    assertEquals(Object.keys(again.body).sort(), ["home", "notifications"]);
    assertEquals(again.body.home.updated_at, test.clock.now().toISOString());

    assertEquals(await test.markers(both), { home: ["b", 2], notifications: ["c", 1] });
    assertEquals(await test.markers("?timeline=home"), { home: ["b", 2] });
    assertEquals(await test.markers("?timeline[]=public&timeline[]=notifications"), {
        notifications: ["c", 1],
    });
    assertEquals(await test.markers(""), {});
});

Deno.test("markers are set by forms, with Rails-style names", async () => {
    await using test = await open();
    const saved = await test.request("POST", "/api/v1/markers", {
        form: "notifications[last_read_id]=d",
    });

    assertEquals(saved.status, 200);
    assertEquals(await test.markers("?timeline[]=notifications"), { notifications: ["d", 1] });
});

Deno.test("markers are each user's own", async () => {
    await using test = await open();
    await test.request("POST", "/api/v1/markers", { body: { home: { last_read_id: "a" } } });
    await test.request("POST", "/api/v1/markers", {
        as: "bob",
        body: { home: { last_read_id: "b" } },
    });

    assertEquals(await test.markers("?timeline[]=home"), { home: ["a", 1] });
    assertEquals(await test.markers("?timeline[]=home", "bob"), { home: ["b", 1] });
});

Deno.test("a marker needs an id of at most 100 characters, and reading or saving them takes statuses scopes", async () => {
    await using test = await open();
    const empty = { body: { home: { last_read_id: "" } } };
    const reading = { scopes: ["read:statuses" as const] };

    assertEquals((await test.request("POST", "/api/v1/markers", empty)).status, 422);
    for (const [length, status] of [[100, 200], [101, 422]]) {
        const body = { home: { last_read_id: "1".repeat(length) } };
        assertEquals((await test.request("POST", "/api/v1/markers", { body })).status, status);
    }
    assertEquals((await test.request("GET", "/api/v1/markers", reading)).status, 200);
    assertEquals(
        (await test.request("GET", "/api/v1/markers", { scopes: ["read:notifications"] })).status,
        403,
    );
    assertEquals(
        (await test.request("POST", "/api/v1/markers", { ...reading, body: {} })).status,
        403,
    );
});
