import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { App } from "../http/app.ts";
import { routes } from "../http/routes.ts";
import { createInstance, defaultSettings } from "../instances/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { block } from "./blocks.ts";
import { acceptFollow, follow } from "./follows.ts";
import { mute } from "./mutes.ts";
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
    const path = "/api/v1/accounts/relationships?id=alice&id=carol";

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

/** The accounts on a page of `path`, by id, and its links, asked with `token` or by anyone. */
const list = async (app: App, path: string, token?: string) => {
    const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
    const response = await app.request(path, { headers });
    const body = await response.json();

    return {
        status: response.status,
        ids: Array.isArray(body) ? body.map((account: { id: string }) => account.id) : body,
        link: response.headers.get("link"),
    };
};

const openLists = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, graphRoutes, { checkResponses: true });
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    for (const id of ["alice", "bob", "dave", "erin"]) await createLocalAccount(test.ctx, id);

    // Each a millisecond after the last, so they are listed in this order.
    const follows = async (pairs: [string, string][]) => {
        for (const [follower, followee] of pairs) {
            test.clock.advance(1);
            await follow(test.ctx, follower, followee);
        }
    };

    return { ...test, app, follows };
};

Deno.test("an account's followers and follows are listed newest first, a page at a time", async () => {
    await using test = await openLists();
    await test.follows([["bob", "alice"], ["carol", "alice"], ["dave", "alice"], ["alice", "bob"]]);
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await test.follows([["erin", "alice"], ["alice", "carol"]]);
    const cursor = async (follower: string) =>
        (await test.ctx.db.selectFrom("follows").select("id")
            .where("follower_id", "=", follower).where("followee_id", "=", "alice")
            .executeTakeFirstOrThrow()).id;
    const url = "https://social.example/api/v1/accounts/alice/followers";

    // Erin only asked, and carol hasn't accepted alice yet.
    const first = await list(test.app, "/api/v1/accounts/alice/followers?limit=2");
    assertEquals(first.ids, ["dave", "carol"]);
    assertEquals(
        first.link,
        `<${url}?limit=2&max_id=${await cursor("carol")}>; rel="next", ` +
            `<${url}?limit=2&min_id=${await cursor("dave")}>; rel="prev"`,
    );

    const rest = await list(
        test.app,
        `/api/v1/accounts/alice/followers?max_id=${await cursor("carol")}`,
    );
    assertEquals([rest.status, rest.ids], [200, ["bob"]]);

    const all = await list(test.app, "/api/v1/accounts/alice/followers");
    assertEquals(all.ids, ["dave", "carol", "bob"]);
    assertEquals(all.link, `<${url}?min_id=${await cursor("dave")}>; rel="prev"`);
    assertEquals((await list(test.app, "/api/v1/accounts/alice/following")).ids, ["bob"]);
    assertEquals((await list(test.app, "/api/v1/accounts/carol/followers")).ids, []);
    assertEquals((await list(test.app, "/api/v1/accounts/missing/followers")).status, 404);
});

Deno.test("an account that hides its follows shows them only to itself", async () => {
    await using test = await openLists();
    await test.follows([["bob", "alice"], ["alice", "dave"]]);
    await test.ctx.db.updateTable("accounts").set({ hide_collections: true })
        .where("id", "=", "alice").execute();

    for (const side of ["followers", "following"]) {
        const path = `/api/v1/accounts/alice/${side}`;
        assertEquals(await list(test.app, path), { status: 200, ids: [], link: null }, side);
        assertEquals(
            (await list(test.app, path, await tokenFor(test.ctx, "bob"))).ids,
            [],
            side,
        );
        assertEquals(
            (await list(test.app, path, await tokenFor(test.ctx, "alice"))).ids,
            [side === "followers" ? "bob" : "dave"],
            side,
        );
    }
});

Deno.test("follows are listed to whoever may see them", async () => {
    await using test = await openLists();
    const app = createTestApp(test.ctx, graphRoutes, {
        permissions: { anonymous: ["read:account"], default: ["read:account"] },
    });
    const path = "/api/v1/accounts/alice/followers";

    assertEquals((await list(app, path)).status, 403);
    assertEquals((await list(app, path, await tokenFor(test.ctx, "bob"))).status, 403);
    assertEquals(
        (await list(test.app, path, await tokenFor(test.ctx, "bob", ["write"]))).status,
        403,
    );
    assertEquals(
        (await list(test.app, path, await tokenFor(test.ctx, "bob", ["read:accounts"]))).status,
        200,
    );
});

Deno.test("the accounts asking to follow the viewer are listed newest first, a page at a time", async () => {
    await using test = await openLists();
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await test.follows([["bob", "alice"], ["carol", "alice"], ["dave", "alice"], [
        "alice",
        "erin",
    ]]);
    await acceptFollow(test.ctx, "bob", "alice");
    const token = await tokenFor(test.ctx, "alice");
    const cursor = async (follower: string) =>
        (await test.ctx.db.selectFrom("follows").select("id")
            .where("follower_id", "=", follower).where("followee_id", "=", "alice")
            .executeTakeFirstOrThrow()).id;
    const url = "https://social.example/api/v1/follow_requests";

    // Bob was accepted, and alice follows erin.
    const first = await list(test.app, "/api/v1/follow_requests?limit=1", token);
    assertEquals(first.ids, ["dave"]);
    assertEquals(
        first.link,
        `<${url}?limit=1&max_id=${await cursor("dave")}>; rel="next", ` +
            `<${url}?limit=1&min_id=${await cursor("dave")}>; rel="prev"`,
    );
    assertEquals((await list(test.app, "/api/v1/follow_requests", token)).ids, ["dave", "carol"]);
    assertEquals(
        (await list(test.app, "/api/v1/follow_requests", await tokenFor(test.ctx, "erin"))).ids,
        [],
    );
});

Deno.test("a request is accepted or rejected, and only a request", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");
    const answer = (id: string, verb: string) =>
        test.request("POST", `/api/v1/follow_requests/${id}/${verb}`);

    assertEquals(await answer("bob", "authorize"), {
        status: 200,
        body: { ...none, id: "bob", followed_by: true },
    });
    assertEquals(await answer("carol", "reject"), { status: 200, body: { ...none, id: "carol" } });

    for (const [id, verb] of [["bob", "authorize"], ["bob", "reject"], ["carol", "authorize"]]) {
        assertEquals((await answer(id, verb)).status, 404, `${verb} ${id}`);
    }
    assertEquals((await answer("dave", "reject")).status, 404);
    assertEquals((await test.request("GET", "/api/v1/accounts/relationships?id=bob")).body, [
        { ...none, id: "bob", followed_by: true },
    ]);
});

Deno.test("removing a follower leaves a request alone", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "carol", "alice");
    const remove = (id: string) =>
        test.request("POST", `/api/v1/accounts/${id}/remove_from_followers`);

    assertEquals(await remove("bob"), { status: 200, body: { ...none, id: "bob" } });
    assertEquals(await remove("carol"), {
        status: 200,
        body: { ...none, id: "carol", requested_by: true },
    });
    assertEquals((await remove("dave")).status, 404);
});

Deno.test("answering follows needs a token that may, and a role that may follow", async () => {
    await using test = await open();
    const paths = [
        "/api/v1/follow_requests/bob/authorize",
        "/api/v1/follow_requests/bob/reject",
        "/api/v1/accounts/bob/remove_from_followers",
    ];

    assertEquals(
        (await test.request("GET", "/api/v1/follow_requests", { scopes: ["read:accounts"] }))
            .status,
        403,
    );
    assertEquals(
        (await test.request("GET", "/api/v1/follow_requests", { scopes: ["read:follows"] }))
            .status,
        200,
    );
    for (const path of paths) {
        assertEquals((await test.request("POST", path, { scopes: ["read"] })).status, 403, path);
    }

    const app = createTestApp(test.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    for (const path of paths) {
        const response = await app.request(path, {
            method: "POST",
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` },
        });
        await response.body?.cancel();
        assertEquals(response.status, 403, path);
    }
});

Deno.test("an account's owner sees how many ask to follow it", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    for (const id of ["alice", "bob", "dave", "erin"]) await createLocalAccount(test.ctx, id);
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    for (const id of ["bob", "dave", "erin"]) await follow(test.ctx, id, "alice");
    await follow(test.ctx, "alice", "bob");
    await acceptFollow(test.ctx, "dave", "alice");
    await acceptFollow(test.ctx, "erin", "alice");

    const count = async (id: string) => {
        const response = await app.request("/api/v1/accounts/verify_credentials", {
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, id)}` },
        });
        return (await response.json()).source.follow_requests_count;
    };

    // Alice has two followers, and bob follows nobody who hasn't accepted.
    assertEquals([await count("alice"), await count("bob")], [1, 0]);
});

Deno.test("blocking gives the relationship as it is now, and unblocking undoes it", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "bob", "alice");
    const following = { ...none, following: true, showing_reblogs: true, followed_by: true };

    // The follows stay, and alice can still follow bob.
    assertEquals(await test.request("POST", "/api/v1/accounts/bob/block"), {
        status: 200,
        body: { id: "bob", ...following, blocking: true },
    });
    assertEquals((await test.request("POST", "/api/v1/accounts/bob/follow")).status, 200);

    assertEquals(await test.request("POST", "/api/v1/accounts/bob/unblock"), {
        status: 200,
        body: { id: "bob", ...following },
    });
});

Deno.test("only those who may see everyone's blocks are shown who blocks them", async () => {
    await using test = await open();
    await test.request("POST", "/api/v1/accounts/bob/block");
    const bob = { authorization: `Bearer ${await tokenFor(test.ctx, "bob")}` };
    const path = "/api/v1/accounts/relationships?id=alice&id=carol";

    assertEquals(await test.request("GET", path, { token: await tokenFor(test.ctx, "bob") }), {
        status: 200,
        body: [{ id: "alice", ...none }, { id: "carol", ...none }],
    });

    const moderated = createTestApp(test.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["blocks"] },
    });
    const response = await moderated.request(path, { headers: bob });
    assertEquals(await response.json(), [
        { id: "alice", ...none, blocked_by: true },
        { id: "carol", ...none },
    ]);
});

Deno.test("an account that isn't there, or the viewer's own, can't be blocked", async () => {
    await using test = await open();

    assertEquals((await test.request("POST", "/api/v1/accounts/dave/block")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/alice/block")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/dave/unblock")).status, 404);
});

Deno.test("blocking needs a token that may write blocks, and a role that may block", async () => {
    await using test = await open();

    for (const path of ["/api/v1/accounts/bob/block", "/api/v1/accounts/bob/unblock"]) {
        assertEquals((await test.request("POST", path, { scopes: ["write:follows"] })).status, 403);
        assertEquals((await test.request("POST", path, { scopes: ["write:blocks"] })).status, 200);
    }
    assertEquals(
        (await test.request("GET", "/api/v1/blocks", { scopes: ["read:follows"] })).status,
        403,
    );
    assertEquals(
        (await test.request("GET", "/api/v1/blocks", { scopes: ["read:blocks"] })).status,
        200,
    );

    await using limited = await createTestContext();
    await createLocalAccount(limited.ctx, "alice");
    await createLocalAccount(limited.ctx, "bob");
    const app = createTestApp(limited.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    for (
        const [method, path] of [["POST", "/api/v1/accounts/bob/block"], ["GET", "/api/v1/blocks"]]
    ) {
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${await tokenFor(limited.ctx, "alice")}` },
        });
        await response.body?.cancel();
        assertEquals(response.status, 403, path);
    }
});

Deno.test("the accounts the viewer blocks are listed, the latest blocked first, a page at a time", async () => {
    await using test = await openLists();
    for (const id of ["bob", "carol", "dave"]) {
        test.clock.advance(1);
        await block(test.ctx, "alice", id);
    }
    await block(test.ctx, "erin", "alice");
    const token = await tokenFor(test.ctx, "alice");
    const cursor = async (target: string) =>
        (await test.ctx.db.selectFrom("blocks").select("id")
            .where("account_id", "=", "alice").where("target_id", "=", target)
            .executeTakeFirstOrThrow()).id;
    const url = "https://social.example/api/v1/blocks";

    const first = await list(test.app, "/api/v1/blocks?limit=1", token);
    assertEquals(first.ids, ["dave"]);
    assertEquals(
        first.link,
        `<${url}?limit=1&max_id=${await cursor("dave")}>; rel="next", ` +
            `<${url}?limit=1&min_id=${await cursor("dave")}>; rel="prev"`,
    );
    assertEquals((await list(test.app, "/api/v1/blocks", token)).ids, ["dave", "carol", "bob"]);
    assertEquals((await list(test.app, "/api/v1/blocks", await tokenFor(test.ctx, "bob"))).ids, []);
});

Deno.test("muting gives the relationship with the mute, and unmuting undoes it", async () => {
    await using test = await open();
    const now = test.clock.now().getTime();

    const muted = await test.request("POST", "/api/v1/accounts/bob/mute");
    assertEquals([muted.status, muted.body], [200, {
        ...none,
        id: "bob",
        muting: true,
        muting_notifications: true,
    }]);

    const changed = await test.request("POST", "/api/v1/accounts/bob/mute", {
        body: JSON.stringify({ notifications: false, duration: 60 }),
    });
    assertEquals(changed.body, {
        ...none,
        id: "bob",
        muting: true,
        muting_expires_at: new Date(now + 60_000).toISOString(),
    });
    // Only alice is shown it.
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/relationships?id=alice", {
            token: await tokenFor(test.ctx, "bob"),
        })).body,
        [{ ...none, id: "alice" }],
    );

    const unmuted = await test.request("POST", "/api/v1/accounts/bob/unmute");
    assertEquals([unmuted.status, unmuted.body], [200, { ...none, id: "bob" }]);
});

Deno.test("an account that isn't there, or the viewer's own, can't be muted, nor for too long", async () => {
    await using test = await open();
    const fiveYears = 5 * 365 * 24 * 60 * 60;
    const muting = (path: string, duration?: number) =>
        test.request("POST", path, { body: JSON.stringify({ duration }) });

    assertEquals((await muting("/api/v1/accounts/missing/mute")).status, 404);
    assertEquals((await muting("/api/v1/accounts/alice/mute")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/accounts/missing/unmute")).status, 404);
    assertEquals((await muting("/api/v1/accounts/bob/mute", fiveYears + 1)).status, 422);
    assertEquals((await muting("/api/v1/accounts/bob/mute", -1)).status, 422);
    assertEquals((await muting("/api/v1/accounts/bob/mute", fiveYears)).status, 200);
});

Deno.test("muting needs a token that may write mutes, and a role that may mute", async () => {
    await using test = await open();

    for (const path of ["/api/v1/accounts/bob/mute", "/api/v1/accounts/bob/unmute"]) {
        assertEquals((await test.request("POST", path, { scopes: ["write:blocks"] })).status, 403);
        assertEquals((await test.request("POST", path, { scopes: ["write:mutes"] })).status, 200);
    }
    assertEquals(
        (await test.request("GET", "/api/v1/mutes", { scopes: ["read:blocks"] })).status,
        403,
    );
    assertEquals(
        (await test.request("GET", "/api/v1/mutes", { scopes: ["read:mutes"] })).status,
        200,
    );

    await using limited = await createTestContext();
    await createLocalAccount(limited.ctx, "alice");
    await createLocalAccount(limited.ctx, "bob");
    const app = createTestApp(limited.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    for (
        const [method, path] of [
            ["POST", "/api/v1/accounts/bob/mute"],
            ["POST", "/api/v1/accounts/bob/unmute"],
            ["GET", "/api/v1/mutes"],
        ]
    ) {
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${await tokenFor(limited.ctx, "alice")}` },
        });
        await response.body?.cancel();
        assertEquals(response.status, 403, path);
    }
});

Deno.test("the accounts the viewer mutes are listed, the latest muted first, with when each ends", async () => {
    await using test = await open();
    const now = test.clock.now().getTime();
    await mute(test.ctx, "alice", "bob", { notifications: true, duration: 60 });
    test.clock.advance(1);
    await mute(test.ctx, "alice", "carol", { notifications: true, duration: 0 });
    await mute(test.ctx, "bob", "alice", { notifications: true, duration: 0 });
    const listed = async (as = "alice") =>
        (await test.request("GET", "/api/v1/mutes", { token: await tokenFor(test.ctx, as) }))
            .body.map((account: { id: string; mute_expires_at: string | null }) => [
                account.id,
                account.mute_expires_at,
            ]);

    assertEquals(await listed(), [["carol", null], ["bob", new Date(now + 60_000).toISOString()]]);
    assertEquals(await listed("bob"), [["alice", null]]);

    const page = await test.request("GET", "/api/v1/mutes?limit=1");
    assertEquals(page.body.map((account: { id: string }) => account.id), ["carol"]);
});

Deno.test("noting an account gives the relationship with the note, which only the viewer sees", async () => {
    await using test = await open();
    const noting = (id: string, comment?: string) =>
        test.request("POST", `/api/v1/accounts/${id}/note`, {
            body: JSON.stringify(comment === undefined ? {} : { comment }),
        });

    const noted = await noting("bob", "Met at the meetup");
    assertEquals([noted.status, noted.body], [200, {
        ...none,
        id: "bob",
        note: "Met at the meetup",
    }]);
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/relationships?id=bob")).body[0].note,
        "Met at the meetup",
    );
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/relationships?id=bob", {
            token: await tokenFor(test.ctx, "bob"),
        })).body[0].note,
        "",
    );

    assertEquals((await noting("bob")).body.note, "");
    assertEquals((await noting("missing", "Hi")).status, 404);
    assertEquals((await noting("bob", "é".repeat(2000))).status, 200);
    assertEquals((await noting("bob", "é".repeat(2001))).status, 422);
});

Deno.test("noting an account needs a token that may write accounts, and a role that may change one's own", async () => {
    await using test = await open();
    const path = "/api/v1/accounts/bob/note";

    assertEquals((await test.request("POST", path, { scopes: ["write:follows"] })).status, 403);
    assertEquals((await test.request("POST", path, { scopes: ["write:accounts"] })).status, 200);

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

Deno.test("blocking a domain shows in the relationships with its accounts, and unblocking undoes it", async () => {
    await using test = await open();
    const path = "/api/v1/accounts/relationships?id=bob&id=carol";
    const domain = (name: string) => ({ body: JSON.stringify({ domain: name }) });

    assertEquals(await test.request("POST", "/api/v1/domain_blocks", domain("B.Example")), {
        status: 200,
        body: {},
    });
    assertEquals((await test.request("GET", path)).body, [
        { id: "bob", ...none },
        { id: "carol", ...none, domain_blocking: true },
    ]);
    assertEquals(
        (await test.request("GET", path, { token: await tokenFor(test.ctx, "bob") })).body,
        [
            { id: "bob", ...none },
            { id: "carol", ...none },
        ],
    );

    assertEquals(await test.request("DELETE", "/api/v1/domain_blocks", domain("b.example")), {
        status: 200,
        body: {},
    });
    assertEquals((await test.request("GET", path)).body[1], { id: "carol", ...none });
    assertEquals(
        (await test.request("DELETE", "/api/v1/domain_blocks", domain("b.example"))).status,
        200,
    );
});

Deno.test("only a domain name can be blocked or unblocked", async () => {
    await using test = await open();

    for (const method of ["POST", "DELETE"]) {
        for (const body of ["{}", '{"domain":"not a domain"}', '{"domain":"example"}']) {
            assertEquals(
                (await test.request(method, "/api/v1/domain_blocks", { body })).status,
                422,
                `${method} ${body}`,
            );
        }
    }
});

Deno.test("the domains the viewer blocks are listed, the latest blocked first, a page at a time", async () => {
    await using test = await open();
    for (const domain of ["b.example", "c.example"]) {
        test.clock.advance(1);
        await test.request("POST", "/api/v1/domain_blocks", {
            body: JSON.stringify({ domain }),
        });
    }

    assertEquals(await test.request("GET", "/api/v1/domain_blocks"), {
        status: 200,
        body: ["c.example", "b.example"],
    });
    assertEquals((await test.request("GET", "/api/v1/domain_blocks?limit=1")).body, ["c.example"]);
    assertEquals(
        (await test.request("GET", "/api/v1/domain_blocks", {
            token: await tokenFor(test.ctx, "bob"),
        })).body,
        [],
    );
});

Deno.test("blocking domains needs a token that may write blocks, and a role that may block", async () => {
    await using test = await open();
    const body = JSON.stringify({ domain: "b.example" });

    for (const method of ["POST", "DELETE"]) {
        const path = "/api/v1/domain_blocks";
        assertEquals(
            (await test.request(method, path, { body, scopes: ["write:follows"] })).status,
            403,
        );
        assertEquals(
            (await test.request(method, path, { body, scopes: ["write:blocks"] })).status,
            200,
        );
    }
    assertEquals(
        (await test.request("GET", "/api/v1/domain_blocks", { scopes: ["read:follows"] })).status,
        403,
    );
    assertEquals(
        (await test.request("GET", "/api/v1/domain_blocks", { scopes: ["read:blocks"] })).status,
        200,
    );

    await using limited = await createTestContext();
    await createLocalAccount(limited.ctx, "alice");
    const app = createTestApp(limited.ctx, graphRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    for (const method of ["POST", "DELETE", "GET"]) {
        const response = await app.request("/api/v1/domain_blocks", {
            method,
            body: method === "GET" ? undefined : body,
            headers: {
                authorization: `Bearer ${await tokenFor(limited.ctx, "alice")}`,
                "content-type": "application/json",
            },
        });
        await response.body?.cancel();
        assertEquals(response.status, 403, method);
    }
});
