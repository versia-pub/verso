import { assertEquals } from "@std/assert";
import { decode } from "fast-png";
import { z } from "zod";
import { tokenFor } from "../auth/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { memoryRateLimitStore } from "../http/rate_limits.ts";
import { defineRoute } from "../http/route.ts";
import { createInstance } from "../instances/testing.ts";
import { Limits } from "../kernel/config_sections.ts";
import { createTestContext } from "../testing/context.ts";
import { accountRoutes } from "./routes.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";
import { webfingerRoutes } from "./webfinger.ts";

const ping = defineRoute({
    method: "GET",
    path: "/api/v1/ping",
    summary: "Answers anyone",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [...accountRoutes(Limits.parse({})), ping], {
        checkResponses: true,
        rateLimits: {
            store: memoryRateLimitStore(test.clock),
            policy: { limit: 2, windowSeconds: 60 },
            instancePolicy: { limit: 2, windowSeconds: 60 },
        },
    });
    await createLocalAccount(test.ctx, "019a");

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

/** The API, without rate limits, with alice on the local instance and bob on a remote one. */
const openApi = async (limits: Limits = Limits.parse({})) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, accountRoutes(limits), { checkResponses: true });

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

    const update = async (body: string, type = "application/json", token?: string) => {
        const response = await app.request("/api/v1/accounts/update_credentials", {
            method: "PATCH",
            body,
            headers: {
                "content-type": type,
                authorization: `Bearer ${token ?? await tokenFor(test.ctx, "alice")}`,
            },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, get, update };
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

Deno.test("anyone sees an account by its id, without its settings", async () => {
    await using test = await openApi();

    const alice = await test.get("/api/v1/accounts/alice");
    assertEquals(alice.status, 200);
    assertEquals(alice.body.acct, "alice");
    assertEquals(alice.body.source, undefined);

    const bob = await test.get("/api/v1/accounts/bob");
    assertEquals([bob.status, bob.body.acct], [200, "bob@b.example"]);

    for (const id of ["missing", "a.b"]) {
        assertEquals(
            await test.get(`/api/v1/accounts/${id}`),
            { status: 404, body: { error: "Record not found" } },
            id,
        );
    }
});

Deno.test("an account is looked up by its username or address", async () => {
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
            "alice@b.example",
            "alice@social.example@x",
        ]
    ) {
        assertEquals((await lookup(acct)).status, 404, acct);
    }

    const bob = await lookup("@bob@B.Example");
    assertEquals([bob.status, bob.body.acct], [200, "bob@b.example"]);
    assertEquals((await test.get("/api/v1/accounts/lookup")).status, 422);
    assertEquals(test.transport.sent, []);
});

Deno.test("only users make Verso look for accounts it doesn't know", async () => {
    await using test = await openApi();
    const path = "/api/v1/accounts/lookup?acct=carol@c.example";

    assertEquals((await test.get(path)).status, 404);
    assertEquals((await test.get(path, await tokenFor(test.ctx, null))).status, 404);
    assertEquals(test.transport.sent, []);

    // c.example can't be reached, which is the same as carol not existing.
    assertEquals((await test.get(path, await tokenFor(test.ctx, "alice"))).status, 404);
    assertEquals(test.transport.sent.map((request) => new URL(request.url).host), ["c.example"]);
});

Deno.test("a user changes their profile with JSON, and gets it back as HTML", async () => {
    await using test = await openApi();

    const { status, body } = await test.update(JSON.stringify({
        display_name: " Alice ",
        note: "Hi <you>\n\nthere",
        locked: true,
        fields_attributes: [{ name: "Site", value: "a & b" }, { name: " ", value: "" }],
        source: { privacy: "unlisted", language: "fr" },
    }));

    assertEquals(status, 200);
    assertEquals(body.display_name, "Alice");
    assertEquals(body.note, "<p>Hi &lt;you&gt;</p><p>there</p>");
    assertEquals(body.source.note, "Hi <you>\n\nthere");
    assertEquals(body.fields, [{ name: "Site", value: "a &amp; b", verified_at: null }]);
    assertEquals(body.source.fields, [{ name: "Site", value: "a & b", verified_at: null }]);
    assertEquals([body.locked, body.source.privacy, body.source.language], [
        true,
        "unlisted",
        "fr",
    ]);

    const again = await test.get("/api/v1/accounts/alice");
    assertEquals([again.body.display_name, again.body.locked], ["Alice", true]);
});

Deno.test("a user changes their profile with a form, and the rest stays", async () => {
    await using test = await openApi();
    await test.update(JSON.stringify({ note: "Kept", bot: true }));

    const form = [
        "locked=1",
        "bot=0",
        "fields_attributes[0][name]=Site",
        "fields_attributes[0][value]=x",
        "source[sensitive]=true",
    ].join("&");
    const { status, body } = await test.update(form, "application/x-www-form-urlencoded");

    assertEquals(status, 200);
    assertEquals([body.locked, body.bot, body.source.sensitive], [true, false, true]);
    assertEquals(body.source.fields, [{ name: "Site", value: "x", verified_at: null }]);
    assertEquals(body.source.note, "Kept");

    assertEquals((await test.update("{}")).body.source.note, "Kept");
});

Deno.test("profile changes are held to the configured limits", async () => {
    await using test = await openApi(
        Limits.parse({ display_name: 3, note: 4, fields: 2, field_name: 5, field_value: 6 }),
    );
    const field = { name: "a", value: "b" };

    for (
        const changes of [
            { display_name: "x".repeat(4) },
            { note: "x".repeat(5) },
            { fields_attributes: [field, field, field] },
            { fields_attributes: [{ name: "x".repeat(6) }] },
            { fields_attributes: [{ name: "a", value: "x".repeat(7) }] },
            { locked: "yes" },
            { source: { privacy: "direct" } },
            { source: { language: "fra" } },
        ]
    ) {
        assertEquals(
            (await test.update(JSON.stringify(changes))).status,
            422,
            JSON.stringify(changes),
        );
    }

    const fits = await test.update(JSON.stringify({
        display_name: "🦊🦊🦊",
        note: "xxxx",
        fields_attributes: [field, { name: "x".repeat(5), value: "x".repeat(6) }],
    }));
    assertEquals([fits.status, fits.body.display_name, fits.body.fields.length], [
        200,
        "🦊🦊🦊",
        2,
    ]);
});

Deno.test("only a token that may write accounts changes a profile", async () => {
    await using test = await openApi();
    const readOnly = await tokenFor(test.ctx, "alice", ["read"]);

    assertEquals((await test.update("{}", "application/json", readOnly)).status, 403);
    assertEquals(
        (await test.update(
            "{}",
            "application/json",
            await tokenFor(test.ctx, "alice", ["write:accounts"]),
        )).status,
        200,
    );
});

Deno.test("accounts show their roles, and their owner the highest, with what they may do", async () => {
    await using test = await openApi();
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Mod", []);
    await test.ctx.db.updateTable("roles")
        .set({ visible: true, color: "#ff3838", priority: 100 })
        .where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");
    await giveRole(test.ctx, "alice", "Mod");
    const token = await tokenFor(test.ctx, "alice");
    const shown = [{ id: "Admin", name: "Admin", color: "#ff3838" }];

    const own = await test.get("/api/v1/accounts/verify_credentials", token);
    const updated = await test.update("{}", "application/json", token);

    assertEquals(own.body.roles, shown);
    assertEquals(own.body.role, {
        id: "Admin",
        name: "Admin",
        color: "#ff3838",
        permissions: "131072",
        highlighted: true,
        collection_limit: 0,
    });
    assertEquals(updated.body.role.id, "Admin");
    assertEquals((await test.get("/api/v1/accounts/alice")).body.roles, shown);
    assertEquals((await test.get("/api/v1/accounts/lookup?acct=alice")).body.roles, shown);
});

Deno.test("viewing accounts and changing one's own follow what config permits", async () => {
    await using test = await createTestContext();
    const routes = [...accountRoutes(Limits.parse({})), ...webfingerRoutes];
    const app = createTestApp(test.ctx, routes, {
        checkResponses: true,
        // Only users may view accounts, and nobody may change their profile.
        permissions: { anonymous: [], default: ["read:account"] },
    });
    const alice = await createLocalAccount(test.ctx, "alice");
    const token = await tokenFor(test.ctx, alice);
    const status = async (path: string, init: RequestInit = {}) => {
        const response = await app.request(path, init);
        await response.body?.cancel();
        return response.status;
    };
    const asAlice = { headers: { authorization: `Bearer ${token}` } };

    const views = [
        `/api/v1/accounts/${alice}`,
        "/api/v1/accounts/lookup?acct=alice",
    ];
    for (const path of views) {
        assertEquals(await status(path), 403, path);
        assertEquals(await status(path, asAlice), 200, path);
    }

    // Remote instances find users with WebFinger, whatever clients may view.
    assertEquals(await status("/.well-known/webfinger?resource=acct:alice@social.example"), 200);

    const update = {
        method: "PATCH",
        headers: { ...asAlice.headers, "content-type": "application/json" },
        body: '{"display_name":"Alice"}',
    };
    assertEquals(await status("/api/v1/accounts/update_credentials", update), 403);
});
