import { assertEquals, assertExists } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { acceptFollow, follow } from "../graph/follows.ts";
import { followsFrom } from "../graph/follow_queries.ts";
import type { Context } from "../kernel/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findAccount } from "./account_queries.ts";
import { localVersiaUser } from "./federation.ts";
import { updateProfile } from "./profile.ts";
import { createLocalAccount } from "./testing.ts";

/** A user `id` on an instance that sends whatever it is told to. */
const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
});

/** Has `token`'s user call the migration method at `path`, and gives its status and body. */
const call = async (
    app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
    token: string,
    method: string,
    path: string,
    body?: object,
) => {
    const response = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
};

/** The account `id` says it moved from, as `ctx` has it. */
const previousOf = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return [row?.previous_host, row?.previous_id];
};

Deno.test("a user says which account they moved from, and then from none", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    b.serve("/.versia/v0.6/entities/User/bob", user("bob"));
    const bob = await ctx.federation.resolve(ctx, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);
    const alice = await createLocalAccount(ctx, "alice");
    const token = await tokenFor(ctx, alice);

    assertEquals((await call(app, token, "GET", "/api/v1/migration")).body, { previous: null });

    const set = await call(app, token, "PUT", "/api/v1/migration/previous", { acct: "bob@b.test" });
    assertEquals([set.status, set.body.previous.id], [200, bob]);
    assertEquals((await call(app, token, "GET", "/api/v1/migration")).body.previous.id, bob);
    assertEquals(await previousOf(ctx, alice), ["b.test", "bob"]);

    const removed = await call(app, token, "DELETE", "/api/v1/migration/previous");
    assertEquals([removed.status, removed.body], [200, { previous: null }]);
    assertEquals(await previousOf(ctx, alice), [null, null]);
});

Deno.test("a user can't say they moved from themselves, or from an account there isn't", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const alice = await createLocalAccount(ctx, "alice");
    const token = await tokenFor(ctx, alice);

    for (const acct of ["alice", "@alice", "alice@a.test", "nobody", "nobody@b.test", "a@b@c"]) {
        const { status } = await call(app, token, "PUT", "/api/v1/migration/previous", { acct });
        assertEquals(status, 422, acct);
    }
    assertEquals(await previousOf(ctx, alice), [null, null]);
});

Deno.test("other instances see the account a user says they moved from", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const alice = await createLocalAccount(a.ctx, "alice");
    const dan = await createLocalAccount(a.ctx, "dan");
    const bob = await createLocalAccount(b.ctx, "bob");
    const carol = await createLocalAccount(b.ctx, "carol");
    const token = await tokenFor(a.ctx, alice);
    const aliceOnB = await b.ctx.federation.resolve(b.ctx, { host: "a.test", id: alice }, "User");
    assertExists(aliceOnB);
    assertEquals(await follow(b.ctx, carol, aliceOnB), "requested");
    await network.drain();

    // Sent to the instances of alice's followers.
    await call(a.app, token, "PUT", "/api/v1/migration/previous", { acct: "bob@b.test" });
    await network.drain();
    assertEquals(await previousOf(b.ctx, aliceOnB), ["b.test", bob]);

    // Fetched, an account on alice's own instance.
    await call(a.app, token, "PUT", "/api/v1/migration/previous", { acct: "dan" });
    await b.ctx.federation.resolve(b.ctx, { host: "a.test", id: alice }, "User", undefined, 0);
    assertEquals(await previousOf(b.ctx, aliceOnB), ["a.test", dan]);

    await call(a.app, token, "DELETE", "/api/v1/migration/previous");
    await network.drain();
    assertEquals(await previousOf(b.ctx, aliceOnB), [null, null]);
});

Deno.test("a remote user moves to a local account that says it moved from it", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    b.serve("/.versia/v0.6/entities/User/bob", user("bob"));
    const bob = await ctx.federation.resolve(ctx, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);
    const alice = await createLocalAccount(ctx, "alice");
    const bea = await createLocalAccount(ctx, "bea");
    assertEquals(await follow(ctx, bea, bob), "requested");
    assertEquals(await acceptFollow(ctx, bea, bob), true);
    const token = await tokenFor(ctx, alice);
    await call(app, token, "PUT", "/api/v1/migration/previous", { acct: "bob@b.test" });

    const sent = await b.send("https://a.test/.versia/v0.6/inbox", {
        body: {
            type: "pub.versia:migration/Migration",
            created_at: network.clock.now().toISOString(),
            author: "b.test:bob",
            destination: `a.test:${alice}`,
        },
    });
    assertEquals(sent.status, 202);
    await network.drain();

    assertEquals((await call(app, token, "GET", `/api/v1/accounts/${bob}`)).body.moved.id, alice);
    const follows = await followsFrom(ctx, bea, [bob, alice]);
    assertEquals(follows.map((row) => [row.followee_id, row.accepted]), [[alice, true]]);
});

Deno.test("a user's previous account is sent with the custom emojis they use", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    await createLocalEmoji(ctx, "blob");
    const alice = await createLocalAccount(ctx, "alice");
    const dan = await createLocalAccount(ctx, "dan");
    await updateProfile(ctx, alice, { displayName: "Alice :blob:" });
    await call(app, await tokenFor(ctx, alice), "PUT", "/api/v1/migration/previous", {
        acct: "dan",
    });

    const extensions = (await localVersiaUser(ctx, alice))?.extensions;
    assertEquals(Object.keys(extensions ?? {}).sort(), [
        "pub.versia:custom_emojis",
        "pub.versia:migration",
    ]);
    assertEquals(extensions?.["pub.versia:migration"], { previous: dan });
});

Deno.test("saying which account a user moved from doesn't accept their follow requests", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const alice = await createLocalAccount(ctx, "alice");
    const bea = await createLocalAccount(ctx, "bea");
    await updateProfile(ctx, alice, { locked: true });
    assertEquals(await follow(ctx, bea, alice), "requested");

    await call(app, await tokenFor(ctx, alice), "PUT", "/api/v1/migration/previous", {
        acct: "bea",
    });
    await network.drain();
    assertEquals((await followsFrom(ctx, bea, [alice]))[0].accepted, false);
});

Deno.test("reading a user's migration needs read:accounts, and changing it write:accounts", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const alice = await createLocalAccount(ctx, "alice");
    await createLocalAccount(ctx, "bea");
    const reading = await tokenFor(ctx, alice, ["read:accounts"]);
    const writing = await tokenFor(ctx, alice, ["write:accounts"]);

    assertEquals((await call(app, writing, "GET", "/api/v1/migration")).status, 403);
    for (const method of ["PUT", "DELETE"]) {
        const refused = await call(app, reading, method, "/api/v1/migration/previous", {
            acct: "bea",
        });
        assertEquals(refused.status, 403, method);
    }
    assertEquals((await call(app, reading, "GET", "/api/v1/migration")).status, 200);
});
