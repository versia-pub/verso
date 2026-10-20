import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { routes } from "../http/routes.ts";
import { createInstance, defaultSettings } from "../instances/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { follow } from "./follows.ts";
import { graphRoutes } from "./routes.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, graphRoutes, { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    const request = async (
        method: string,
        path: string,
        options: { body?: string; token?: string; scopes?: Scope[] } = {},
    ) => {
        const token = options.token ?? await tokenFor(test.ctx, "alice", options.scopes);
        const response = await app.request(path, {
            method,
            body: options.body,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, request };
};

/** The relationship of an account no one follows. */
const none = {
    following: false,
    showing_reblogs: false,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    muting_expires_at: null,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: "",
};

Deno.test("relationships are given for each account asked about, once, in order", async () => {
    await using test = await open();
    const ids = (body: { id: string }[]) => body.map((relationship) => relationship.id);

    const many = await test.request(
        "GET",
        "/api/v1/accounts/relationships?id[]=carol&id[]=bob&id[]=missing&id[]=alice&id[]=carol",
    );
    assertEquals([many.status, ids(many.body)], [200, ["carol", "bob", "alice"]]);
    assertEquals(many.body[0], { id: "carol", ...none });

    const one = await test.request("GET", "/api/v1/accounts/relationships?id=alice");
    assertEquals(ids(one.body), ["alice"]);
    assertEquals((await test.request("GET", "/api/v1/accounts/relationships")).body, []);
});

Deno.test("relationships show follows and requests both ways", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob", { showReblogs: false, notify: true, languages: ["en"] });
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "alice", "carol");
    await createLocalAccount(test.ctx, "dave");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "dave", "alice");

    const { body } = await test.request(
        "GET",
        "/api/v1/accounts/relationships?id[]=bob&id[]=carol&id[]=dave",
    );
    assertEquals(body, [
        {
            ...none,
            id: "bob",
            following: true,
            showing_reblogs: false,
            notifying: true,
            languages: ["en"],
            followed_by: true,
        },
        { ...none, id: "carol", showing_reblogs: true, requested: true },
        { ...none, id: "dave", requested_by: true },
    ]);
});

Deno.test("relationships need a user's token that may read follows", async () => {
    await using test = await open();
    const path = "/api/v1/accounts/relationships?id=alice";

    assertEquals((await test.request("GET", path, { scopes: ["read:follows"] })).status, 200);
    assertEquals((await test.request("GET", path, { scopes: ["read:accounts"] })).status, 403);
    assertEquals(
        (await test.request("GET", path, { token: await tokenFor(test.ctx, null) })).status,
        422,
    );
});

Deno.test("following gives the relationship as it is now, and unfollowing undoes it", async () => {
    await using test = await open();

    const followed = await test.request("POST", "/api/v1/accounts/bob/follow", {
        body: '{"reblogs":false,"notify":true,"languages":["en"]}',
    });
    assertEquals(followed, {
        status: 200,
        body: {
            ...none,
            id: "bob",
            following: true,
            showing_reblogs: false,
            notifying: true,
            languages: ["en"],
        },
    });

    // An empty list of languages means all of them, and options left out stay as they were.
    const changed = await test.request("POST", "/api/v1/accounts/bob/follow", {
        body: '{"languages":[]}',
    });
    assertEquals([changed.body.languages, changed.body.notifying], [null, true]);

    const asked = await test.request("POST", "/api/v1/accounts/carol/follow");
    assertEquals([asked.status, asked.body.following, asked.body.requested], [200, false, true]);

    const unfollowed = await test.request("POST", "/api/v1/accounts/bob/unfollow");
    assertEquals(unfollowed, { status: 200, body: { ...none, id: "bob" } });
    const withdrawn = await test.request("POST", "/api/v1/accounts/carol/unfollow");
    assertEquals(withdrawn, { status: 200, body: { ...none, id: "carol" } });
});

Deno.test("an account that isn't there, the viewer's own, or a blocked one can't be followed", async () => {
    await using test = await open();
    await blockDomain(test.ctx, "b.example");

    assertEquals((await test.request("POST", "/api/v1/accounts/dave/follow")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/alice/follow")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/dave/unfollow")).status, 404);

    const blocked = await test.request("POST", "/api/v1/accounts/carol/follow");
    assertEquals(blocked, {
        status: 403,
        body: { error: "This action is not allowed", error_description: "Its instance is blocked" },
    });
});

Deno.test("following needs a token that may write follows, and a role that may follow", async () => {
    await using test = await open();
    const path = "/api/v1/accounts/bob/follow";

    assertEquals((await test.request("POST", path, { scopes: ["write:accounts"] })).status, 403);
    assertEquals(
        (await test.request("POST", "/api/v1/accounts/bob/unfollow", { scopes: ["read"] })).status,
        403,
    );
    assertEquals((await test.request("POST", path, { scopes: ["write:follows"] })).status, 200);

    await using limited = await createTestContext();
    await createLocalAccount(limited.ctx, "alice");
    await createLocalAccount(limited.ctx, "bob");
    const app = createTestApp(limited.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    const response = await app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${await tokenFor(limited.ctx, "alice")}` },
    });
    await response.body?.cancel();
    assertEquals(response.status, 403);
});

Deno.test("relationships and follows aren't taken for accounts among every route", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    const headers = { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` };

    const followed = await app.request("/api/v1/accounts/bob/follow", { method: "POST", headers });
    assertEquals([followed.status, (await followed.json()).following], [200, true]);

    const relationships = await app.request("/api/v1/accounts/relationships?id=bob", { headers });
    assertEquals([relationships.status, (await relationships.json())[0]?.following], [200, true]);
});
