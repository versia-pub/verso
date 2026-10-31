import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { postNote } from "../notes/notes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { groupedNotificationRoutes } from "./grouped_routes.ts";
import { notificationPolicyRoutes } from "./policy_routes.ts";
import { notificationRoutes } from "./routes.ts";

/** alice, bob and carol, local users. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(
        test.ctx,
        // As in Verso's routes: before `/api/v2/notifications/:group_key`, which would take it.
        [...notificationRoutes, ...notificationPolicyRoutes, ...groupedNotificationRoutes],
        { checkResponses: true },
    );
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    /** Sends a request as alice, with `body` as JSON if given. */
    const request = async (
        method: string,
        path: string,
        options: { body?: unknown; scopes?: Scope[] } = {},
    ) => {
        const token = await tokenFor(test.ctx, "alice", options.scopes);
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });

        return { status: response.status, body: await response.json() };
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

    return { ...test, request, post };
};

Deno.test("a user's policy has Mastodon's defaults, and how many requests they have", async () => {
    await using test = await open();
    await test.post("bob", "@alice Hi");
    await test.post("bob", "@alice Hi again");
    await test.post("carol", "@alice Hi");

    assertEquals((await test.request("GET", "/api/v2/notifications/policy")).body, {
        for_not_following: "accept",
        for_not_followers: "accept",
        for_new_accounts: "accept",
        for_private_mentions: "filter",
        for_limited_accounts: "filter",
        summary: { pending_requests_count: 2, pending_notifications_count: 3 },
    });
});

Deno.test("a user changes parts of their policy, keeping the others", async () => {
    await using test = await open();
    const path = "/api/v2/notifications/policy";

    await test.request("PATCH", path, { body: { for_not_following: "drop" } });
    const changed = await test.request("PATCH", path, { body: { for_new_accounts: "filter" } });
    assertEquals(changed.status, 200);
    assertEquals(
        [changed.body.for_not_following, changed.body.for_new_accounts],
        ["drop", "filter"],
    );
    assertEquals((await test.request("GET", path)).body.for_private_mentions, "filter");

    const wrong = await test.request("PATCH", path, { body: { for_not_following: "mute" } });
    assertEquals(wrong.status, 422);
});

Deno.test("reading a policy takes read:notifications, and changing it write", async () => {
    await using test = await open();
    const path = "/api/v2/notifications/policy";
    const reading = { scopes: ["read:notifications" as const] };

    assertEquals((await test.request("GET", path, { scopes: ["read:statuses"] })).status, 403);
    assertEquals((await test.request("GET", path, reading)).status, 200);
    assertEquals((await test.request("PATCH", path, { ...reading, body: {} })).status, 403);
    assertEquals(
        (await test.request("PATCH", path, { scopes: ["write:notifications"], body: {} })).status,
        200,
    );
});

Deno.test("filtered notifications are listed and counted only when asked, or by account", async () => {
    await using test = await open();
    const filtered = await test.post("bob", "@alice Hi");
    const ids = async (path: string) => {
        const { body } = await test.request("GET", path);
        return "notification_groups" in body
            ? body.notification_groups.map((group: { status_id: string }) => group.status_id)
            : body.map((each: { status: { id: string } }) => each.status.id);
    };
    const count = async (path: string) => (await test.request("GET", path)).body.count;

    for (const version of ["v1", "v2"]) {
        const path = `/api/${version}/notifications`;
        assertEquals(await ids(path), []);
        assertEquals(await ids(`${path}?include_filtered=true`), [filtered]);
        assertEquals(await ids(`${path}?account_id=bob`), [filtered]);
        assertEquals(await count(`${path}/unread_count`), 0);
        assertEquals(await count(`${path}/unread_count?include_filtered=true`), 1);
    }

    // One on its own is shown, as on Mastodon.
    const [{ id }] = (await test.request("GET", "/api/v1/notifications?include_filtered=1")).body;
    assertEquals((await test.request("GET", `/api/v1/notifications/${id}`)).status, 200);
});
