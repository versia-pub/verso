import { assertEquals, assertExists } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { accountNotesOn } from "../graph/account_note_queries.ts";
import { insertBlock } from "../graph/block_queries.ts";
import { acceptFollow, follow } from "../graph/follows.ts";
import { followsFrom, insertFollow } from "../graph/follow_queries.ts";
import type { Context } from "../kernel/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findAccount } from "./account_queries.ts";
import { localVersiaUser } from "./federation.ts";
import { moveTo } from "./migration.ts";
import { updateProfile } from "./profile.ts";
import { createLocalAccount } from "./testing.ts";

/**
 * A user `id` on an instance that sends whatever it is told to, saying it moved from `previous`, if
 * given.
 */
const user = (id: string, previous?: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
    ...(previous === undefined ? {} : { extensions: { "pub.versia:migration": { previous } } }),
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

    assertEquals((await call(app, token, "GET", "/api/v1/migration")).body, {
        previous: null,
        moved: null,
    });

    const set = await call(app, token, "PUT", "/api/v1/migration/previous", { acct: "bob@b.test" });
    assertEquals([set.status, set.body.previous.id], [200, bob]);
    assertEquals((await call(app, token, "GET", "/api/v1/migration")).body.previous.id, bob);
    assertEquals(await previousOf(ctx, alice), ["b.test", "bob"]);

    const removed = await call(app, token, "DELETE", "/api/v1/migration/previous");
    assertEquals([removed.status, removed.body], [200, { previous: null, moved: null }]);
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
    for (
        const [method, path] of [["PUT", "previous"], ["DELETE", "previous"], ["POST", "move"], [
            "DELETE",
            "move",
        ]]
    ) {
        const refused = await call(app, reading, method, `/api/v1/migration/${path}`, {
            acct: "bea",
        });
        assertEquals(refused.status, 403, `${method} ${path}`);
    }
    assertEquals((await call(app, reading, "GET", "/api/v1/migration")).status, 200);
});

/** The entities sent to `host`, in order. */
const sentTo = async (network: { transport: { sent: Request[] } }, host: string) => {
    const requests = network.transport.sent.filter((request) =>
        request.method === "POST" && new URL(request.url).host === host
    );
    return await Promise.all(requests.map((request) => request.clone().json()));
};

/** A month, how long after moving a user can't move again. */
const month = 30 * 24 * 60 * 60_000;

Deno.test("a user moves to an account that says it moved from theirs, with their followers", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"];
    const b = network.instances["b.test"];
    const alice = await createLocalAccount(a.ctx, "alice");
    const dan = await createLocalAccount(a.ctx, "dan");
    const eve = await createLocalAccount(a.ctx, "eve");
    const bob = await createLocalAccount(b.ctx, "bob");
    const carol = await createLocalAccount(b.ctx, "carol");
    const aliceOnB = await b.ctx.federation.resolve(b.ctx, { host: "a.test", id: alice }, "User");
    assertExists(aliceOnB);
    assertEquals(await follow(a.ctx, dan, alice), "following");
    assertEquals(await follow(b.ctx, carol, aliceOnB), "requested");
    await insertBlock(a.ctx, eve, alice);
    await network.drain();
    await call(b.app, await tokenFor(b.ctx, bob), "PUT", "/api/v1/migration/previous", {
        acct: "alice@a.test",
    });

    const token = await tokenFor(a.ctx, alice);
    const moved = await call(a.app, token, "POST", "/api/v1/migration/move", {
        acct: "bob@b.test",
    });
    await network.drain();

    const bobOnA = moved.body.moved.id;
    assertEquals([moved.status, moved.body.moved.acct], [200, "bob@b.test"]);
    assertEquals(
        (await followsFrom(a.ctx, dan, [alice, bobOnA])).map((
            row,
        ) => [row.followee_id, row.accepted]),
        [[bobOnA, true]],
    );
    assertEquals([...(await accountNotesOn(a.ctx, eve, [bobOnA])).values()], [
        "This user moved from alice, which you had blocked.",
    ]);
    assertEquals((await findAccount(b.ctx, aliceOnB))?.moved_to_account_id, bob);
    assertEquals(
        (await followsFrom(b.ctx, carol, [aliceOnB, bob])).map((row) => row.followee_id),
        [bob],
    );
});

Deno.test("a user moves only to an available account, fetched just now, saying it moved from theirs", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const alice = await createLocalAccount(ctx, "alice");
    const path = (id: string) => `/.versia/v0.6/entities/User/${id}`;
    const resolve = (id: string) => ctx.federation.resolve(ctx, { host: "b.test", id }, "User");
    b.serve(path("carol"), user("carol"));
    b.serve(path("dan"), user("dan", "a.test:dan"));
    b.serve(path("gil"), user("gil", `c.test:${alice}`));
    b.serve(path("erin"), user("erin", `a.test:${alice}`));
    b.serve(path("bob"), user("bob", `a.test:${alice}`));
    const erin = await resolve("erin");
    assertExists(erin);
    for (const id of ["carol", "dan", "gil", "bob"]) await resolve(id);
    const token = await tokenFor(ctx, alice);
    const move = async (acct: string) => {
        network.clock.advance(1);
        const { status, body } = await call(app, token, "POST", "/api/v1/migration/move", { acct });
        return [status, body.details?.acct?.[0]];
    };
    const notPrevious = [422, "The account doesn't say you moved from your account"];

    for (const acct of ["carol@b.test", "dan@b.test", "gil@b.test"]) {
        assertEquals(await move(acct), notPrevious, acct);
    }
    const now = network.clock.now();
    for (
        const set of [{ suspended_at: now }, { deleted_at: now }, { moved_to_account_id: alice }]
    ) {
        const unset = { suspended_at: null, deleted_at: null, moved_to_account_id: null };
        await ctx.db.updateTable("accounts").set({ ...unset, ...set }).where("id", "=", erin)
            .execute();
        assertEquals(
            await move("erin@b.test"),
            [422, "The account can't be moved to"],
            Object.keys(set)[0],
        );
    }

    // Verso has bob saying it moved from alice, but bob no longer says it.
    b.serve(path("bob"), user("bob"));
    assertEquals(await move("bob@b.test"), notPrevious);

    // Nor if bob can't be fetched, though Verso has it saying so.
    b.serve(path("bob"), user("bob", `a.test:${alice}`));
    await ctx.federation.resolve(ctx, { host: "b.test", id: "bob" }, "User", undefined, 0);
    network.transport.down.add("b.test");
    assertEquals(await move("bob@b.test"), [422, "The account couldn't be fetched"]);
    network.transport.down.delete("b.test");
    assertEquals(await move("bob@b.test"), [200, undefined]);
    assertEquals(await move("bob@b.test"), [422, "You already moved to the account"]);
    assertEquals(await previousOf(ctx, alice), [null, null]);
});

Deno.test("a user that moved is sent saying so, along with a Migration to where it moved", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const c = await addEvilInstance(network, "c.test", ["pub.versia:migration"]);
    const alice = await createLocalAccount(ctx, "alice");
    const dan = await createLocalAccount(ctx, "dan");
    c.serve("/.versia/v0.6/entities/User/carol", user("carol"));
    const carol = await ctx.federation.resolve(ctx, { host: "c.test", id: "carol" }, "User");
    assertExists(carol);
    await insertFollow(ctx, { followerId: carol, followeeId: alice, accepted: true, options: {} });
    b.serve("/.versia/v0.6/entities/User/bob", user("bob", `a.test:${alice}`));
    await ctx.federation.resolve(ctx, { host: "b.test", id: "bob" }, "User");
    const token = await tokenFor(ctx, alice);
    await call(app, token, "PUT", "/api/v1/migration/previous", { acct: "dan" });

    const moved = await call(app, token, "POST", "/api/v1/migration/move", { acct: "bob@b.test" });
    assertEquals(moved.status, 200, JSON.stringify(moved.body));
    await network.drain();
    const migration = {
        type: "pub.versia:migration/Migration",
        created_at: network.clock.now().toISOString(),
        author: alice,
        destination: "b.test:bob",
    };
    assertEquals(await sentTo(network, "b.test"), [migration]);
    const toC = await sentTo(network, "c.test");
    assertEquals(toC.find((entity) => entity.type === migration.type), migration);
    assertEquals(toC.findLast((entity) => entity.type === "User")?.extensions, {
        "pub.versia:migration": { previous: dan, new: "b.test:bob" },
    });

    await call(app, token, "DELETE", "/api/v1/migration/previous");
    assertEquals((await localVersiaUser(ctx, alice))?.extensions, {
        "pub.versia:migration": { new: "b.test:bob" },
    });

    await call(app, token, "DELETE", "/api/v1/migration/move");
    await network.drain();
    const cancelled = (await sentTo(network, "c.test")).findLast((entity) =>
        entity.type === "User"
    );
    assertEquals(cancelled?.extensions, undefined);
});

Deno.test("only local users move", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx } = network.instances["a.test"];
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const alice = await createLocalAccount(ctx, "alice");
    b.serve("/.versia/v0.6/entities/User/bob", user("bob", `a.test:${alice}`));
    const bob = await ctx.federation.resolve(ctx, { host: "b.test", id: "bob" }, "User");
    const to = await findAccount(ctx, alice);
    assertExists(bob);
    assertExists(to);

    assertEquals(await moveTo(ctx, bob, to), "unavailable");
    assertEquals(await moveTo(ctx, "nobody", to), "unavailable");
});

Deno.test("a user that cancels their move says they moved nowhere, and moves again a month after", async () => {
    await using network = await createNetwork(["a.test"]);
    const { ctx, app } = network.instances["a.test"];
    const alice = await createLocalAccount(ctx, "alice");
    const bea = await createLocalAccount(ctx, "bea");
    const cid = await createLocalAccount(ctx, "cid");
    const dan = await createLocalAccount(ctx, "dan");
    assertEquals(await follow(ctx, dan, alice), "following");
    for (const id of [bea, cid]) {
        await call(app, await tokenFor(ctx, id), "PUT", "/api/v1/migration/previous", {
            acct: "alice",
        });
    }
    const token = await tokenFor(ctx, alice);
    const move = async (acct: string) =>
        (await call(app, token, "POST", "/api/v1/migration/move", { acct })).status;

    assertEquals(await move("bea"), 200);
    const movedAt = (await findAccount(ctx, alice))?.moved_at;
    const cancelled = await call(app, token, "DELETE", "/api/v1/migration/move");
    assertEquals([cancelled.status, cancelled.body.moved], [200, null]);
    assertEquals((await findAccount(ctx, alice))?.moved_at, movedAt);
    assertEquals((await localVersiaUser(ctx, alice))?.extensions, undefined);
    // The move was cancelled before its followers moved, so they don't.
    await network.drain();
    assertEquals((await followsFrom(ctx, dan, [alice, bea])).map((row) => row.followee_id), [
        alice,
    ]);

    network.clock.advance(month - 1);
    assertEquals(await move("cid"), 422);
    network.clock.advance(1);
    assertEquals(await move("cid"), 200);
    assertEquals((await call(app, token, "GET", "/api/v1/migration")).body.moved.id, cid);
});
