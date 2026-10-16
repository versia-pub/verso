import { assertEquals } from "@std/assert";
import { decode } from "fast-png";
import { z } from "zod";
import { tokenFor } from "../auth/testing.ts";
import { createApp } from "../http/app.ts";
import { memoryRateLimitStore } from "../http/rate_limits.ts";
import { defineRoute } from "../http/route.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import { accountRoutes } from "./routes.ts";
import { createLocalAccount } from "./testing.ts";

const ping = defineRoute({
    method: "GET",
    path: "/api/v1/ping",
    summary: "Answers anyone",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, [...accountRoutes, ping], {
        checkResponses: true,
        rateLimits: {
            store: memoryRateLimitStore(test.clock),
            policy: { limit: 2, windowSeconds: 60 },
        },
    });

    return { ...test, app };
};

Deno.test("an account's default pictures are PNGs anyone may cache for a day", async () => {
    await using test = await open();

    for (const [picture, size] of [["avatar", [420, 420]], ["header", [1500, 500]]] as const) {
        const response = await test.app.request(`/accounts/019a/${picture}.png`);
        const image = decode(new Uint8Array(await response.arrayBuffer()), { checkCrc: true });

        assertEquals(response.status, 200, picture);
        assertEquals(response.headers.get("content-type"), "image/png", picture);
        assertEquals(response.headers.get("cache-control"), "public, max-age=86400", picture);
        assertEquals<readonly number[]>([image.width, image.height], size, picture);
    }
});

Deno.test("an id that can't be an account's is refused", async () => {
    await using test = await open();
    const response = await test.app.request("/accounts/a.b/avatar.png");
    await response.body?.cancel();

    assertEquals(response.status, 422);
    assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("pictures aren't rate limited, unlike the API", async () => {
    await using test = await open();
    const status = async (path: string) => {
        const response = await test.app.request(path);
        await response.body?.cancel();
        return response.status;
    };

    for (let i = 0; i < 3; i++) assertEquals(await status("/accounts/019a/avatar.png"), 200);
    for (let i = 0; i < 2; i++) assertEquals(await status("/api/v1/ping"), 200);
    assertEquals(await status("/api/v1/ping"), 429);
});

/** The API, without rate limits, with alice on this instance and bob on another. */
const openApi = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, accountRoutes, { checkResponses: true });

    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "bob",
            username: "bob",
            instance_id: "b.example",
            remote_id: "1",
            created_at: test.clock.now(),
        })
        .execute();

    const get = async (path: string, token?: string) => {
        const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
        const response = await app.request(path, { headers });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, get };
};

Deno.test("a user sees their own account, with their settings", async () => {
    await using test = await openApi();
    const path = "/api/v1/accounts/verify_credentials";

    const own = await test.get(path, await tokenFor(test.ctx, "alice"));
    assertEquals(own.status, 200);
    assertEquals(own.body.username, "alice");
    assertEquals(own.body.source.privacy, "public");

    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["profile"]))).status,
        200,
    );
    assertEquals((await test.get(path)).status, 401);
    assertEquals((await test.get(path, await tokenFor(test.ctx, null))).status, 422);
    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["read:statuses"]))).status,
        403,
    );
});

Deno.test("anyone sees a local account by its id, without its settings", async () => {
    await using test = await openApi();

    const alice = await test.get("/api/v1/accounts/alice");
    assertEquals(alice.status, 200);
    assertEquals(alice.body.acct, "alice");
    assertEquals(alice.body.source, undefined);

    for (const id of ["missing", "bob", "a.b"]) {
        assertEquals(
            await test.get(`/api/v1/accounts/${id}`),
            { status: 404, body: { error: "Record not found" } },
            id,
        );
    }
});

Deno.test("a local account is looked up by its username or address", async () => {
    await using test = await openApi();
    const lookup = (acct: string) =>
        test.get(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);

    for (
        const acct of ["alice", "ALICE", "@alice", "alice@social.example", "alice@Social.Example"]
    ) {
        const found = await lookup(acct);
        assertEquals([found.status, found.body.id], [200, "alice"], acct);
    }

    for (
        const acct of [
            "",
            "carol",
            "bob",
            "bob@b.example",
            "alice@b.example",
            "alice@social.example@x",
        ]
    ) {
        assertEquals((await lookup(acct)).status, 404, acct);
    }

    assertEquals((await test.get("/api/v1/accounts/lookup")).status, 422);
});
