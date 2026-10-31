import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { postNote } from "../notes/notes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { notificationRequestRoutes } from "./request_routes.ts";
import { notificationRoutes } from "./routes.ts";

/** alice, bob, carol and dave, local users. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(
        test.ctx,
        [...notificationRequestRoutes, ...notificationRoutes],
        { checkResponses: true },
    );
    for (const id of ["alice", "bob", "carol", "dave"]) await createLocalAccount(test.ctx, id);

    /** Sends a request as `as`, with `body` as JSON if given. */
    const request = async (
        method: string,
        path: string,
        options: { as?: string; body?: unknown; scopes?: Scope[] } = {},
    ) => {
        const token = await tokenFor(test.ctx, options.as ?? "alice", options.scopes);
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        return {
            status: response.status,
            body: await response.json(),
            link: response.headers.get("link"),
        };
    };

    /** Posts a direct status as `accountId`, mentioning whoever `text` does. */
    const post = async (accountId: string, text: string) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility: "direct",
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    /** alice's requests, newest first, as who each is from. */
    const from = async () =>
        ((await request("GET", "/api/v1/notifications/requests")).body as {
            account: { id: string };
        }[]).map((each) => each.account.id);

    return { ...test, request, post, from };
};

Deno.test("a user's requests are listed newest first, a page at a time", async () => {
    await using test = await open();
    await test.post("bob", "@alice Hi");
    await test.post("carol", "@alice Hi");
    const latest = await test.post("bob", "@alice Hi again");

    const page = await test.request("GET", "/api/v1/notifications/requests?limit=1");
    assertEquals(page.body.map((each: { account: { id: string } }) => each.account.id), ["carol"]);
    const next = new URL(page.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    const rest = await test.request("GET", next.pathname + next.search);
    assertEquals(rest.body.length, 1);
    assertEquals(
        [rest.body[0].account.id, rest.body[0].notifications_count, rest.body[0].last_status.id],
        ["bob", "2", latest],
    );
});

Deno.test("a request is shown, accepted and dismissed only by its user", async () => {
    await using test = await open();
    await test.post("bob", "@alice Hi");
    const [{ id }] = (await test.request("GET", "/api/v1/notifications/requests")).body;
    const path = `/api/v1/notifications/requests/${id}`;

    assertEquals((await test.request("GET", path)).body.id, id);
    for (const [method, suffix] of [["GET", ""], ["POST", "/accept"], ["POST", "/dismiss"]]) {
        assertEquals((await test.request(method, path + suffix, { as: "carol" })).status, 404);
    }

    assertEquals((await test.request("POST", `${path}/accept`)).body, {});
    assertEquals((await test.request("GET", path)).status, 404);
    assertEquals((await test.request("POST", `${path}/dismiss`)).status, 404);
});

Deno.test("requests are accepted or dismissed several at once, leaving out others' ids", async () => {
    await using test = await open();
    for (const id of ["bob", "carol", "dave"]) await test.post(id, "@alice Hi");
    await test.post("alice", "@bob Hi");
    const ids = async (as: string) =>
        ((await test.request("GET", "/api/v1/notifications/requests", { as })).body as {
            id: string;
            account: { id: string };
        }[]).map((each) => [each.account.id, each.id]);
    const [[, dave], [, carol], [, bob]] = await ids("alice");
    const [[, bobs]] = await ids("bob");

    const accept = await test.request("POST", "/api/v1/notifications/requests/accept", {
        body: { id: [bob, carol, bobs] },
    });
    assertEquals(accept.body, {});
    assertEquals(await test.from(), ["dave"]);
    assertEquals((await ids("bob")).length, 1);

    await test.request("POST", "/api/v1/notifications/requests/dismiss", { body: { id: [dave] } });
    assertEquals(await test.from(), []);
    assertEquals(
        (await test.request("POST", "/api/v1/notifications/requests/dismiss", { body: {} })).status,
        422,
    );
});

Deno.test("accepted requests are merged at once", async () => {
    await using test = await open();
    assertEquals((await test.request("GET", "/api/v1/notifications/requests/merged")).body, {
        merged: true,
    });
});

Deno.test("reading requests takes read:notifications, and accepting or dismissing them write", async () => {
    await using test = await open();
    const reading = { scopes: ["read:notifications" as const] };
    const writing = { scopes: ["write:notifications" as const], body: { id: [] } };

    for (const path of ["", "/merged"]) {
        const at = `/api/v1/notifications/requests${path}`;
        assertEquals((await test.request("GET", at, { scopes: ["read:statuses"] })).status, 403);
        assertEquals((await test.request("GET", at, reading)).status, 200);
    }
    for (const path of ["/accept", "/dismiss"]) {
        const at = `/api/v1/notifications/requests${path}`;
        assertEquals(
            (await test.request("POST", at, { ...reading, body: { id: [] } })).status,
            403,
        );
        assertEquals((await test.request("POST", at, writing)).status, 200);
    }
});
