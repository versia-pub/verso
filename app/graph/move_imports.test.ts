import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { AccountMoved } from "../accounts/events.ts";
import { findRemoteAccountAt, setSilencedAt } from "../accounts/account_queries.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { addEvilInstance, type EvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { insertBlock } from "./block_queries.ts";
import { blockDomainFor } from "./domain_blocks.ts";
import { follow } from "./follows.ts";
import { followsFrom } from "./follow_queries.ts";
import {
    deleteExpiredMoveSubscribers,
    importCollection,
    moveImportHandler,
    moveImportQueue,
    queueMoveImports,
} from "./move_imports.ts";

const user = (id: string) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    manually_approves_subscribers: false,
    indexable: true,
});

const path = (id: string, collection?: string) =>
    `/.versia/v0.7/entities/User/${id}${
        collection === undefined ? "" : `/collections/${collection}`
    }`;

/**
 * a.test, with alice, who is locked and says she moved from b.test's bob, and una and lena, who
 * aren't locked and are. b.test, bob's instance, and c.test, which has carol, dave, erin and gina,
 * send whatever they are told to. All but gina are known to a.test.
 */
const open = async () => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const c = await addEvilInstance(network, "c.test", ["pub.versia:migration"]);
    const e = await addEvilInstance(network, "e.test");
    for (const instance of [b, c, e]) instance.serve("/.versia/v0.7/inbox", {});
    b.serve(path("bob"), user("bob"));
    for (const id of ["carol", "dave", "erin", "gina"]) c.serve(path(id), user(id));
    e.serve(path("frank"), user("frank"));

    const alice = await createLocalAccount(a, "alice");
    const una = await createLocalAccount(a, "una");
    const lena = await createLocalAccount(a, "lena");
    await a.db.updateTable("accounts").set({ locked: true }).where("id", "in", [alice, lena])
        .execute();
    await a.db.updateTable("accounts").set({ previous_host: "b.test", previous_id: "bob" })
        .where("id", "=", alice).execute();

    const resolve = async (host: string, id: string) => {
        const found = await a.federation.resolve(a, { host, id }, "User");
        assertExists(found);
        return found;
    };
    const bob = await resolve("b.test", "bob");
    const carol = await resolve("c.test", "carol");
    const dave = await resolve("c.test", "dave");
    const erin = await resolve("c.test", "erin");
    const frank = await resolve("e.test", "frank");

    /** Has b.test say bob moved to alice, and a.test do what follows. */
    const migrate = async () => {
        const response = await b.send("https://a.test/.versia/v0.7/inbox", {
            body: {
                type: "pub.versia:migration/Migration",
                created_at: network.clock.now().toISOString(),
                author: "b.test:bob",
                destination: "a.test:alice",
            },
        });
        assertEquals(response.status, 202);
        await network.drain();
    };

    /** Makes bob say he moved to `to`, without the jobs a move queues. */
    const moveTo = (to: string) =>
        a.db.updateTable("accounts").set({ moved_to_account_id: to }).where("id", "=", bob)
            .execute();

    /**
     * Makes b.test serve `items` as bob's `name`, a page at a time, running `after` after each, and
     * holding at most `perPage` of them in a page.
     */
    const serveCollection = (
        name: string,
        items: readonly string[],
        options: { after?: () => void; perPage?: number } = {},
    ) => {
        const serve = network.transport.servers.get("b.test");
        assertExists(serve);
        network.transport.servers.set("b.test", async (request) => {
            const url = new URL(request.url);
            if (url.pathname !== path("bob", name)) return await serve(request);

            const offset = Number(url.searchParams.get("offset") ?? 0);
            const limit = Math.min(Number(url.searchParams.get("limit")), options.perPage ?? 40);
            b.serve(path("bob", name), {
                author: "b.test:bob",
                total: items.length,
                items: items.slice(offset, offset + limit),
            });
            const response = await serve(request);
            options.after?.();

            return response;
        });
    };

    /** The offsets of the pages of bob's `name` that a.test asked b.test for. */
    const asked = (name: string) =>
        network.transport.sent.filter((request) =>
            new URL(request.url).pathname === path("bob", name)
        )
            .map((request) => Number(new URL(request.url).searchParams.get("offset")));

    const job = (collection: "subscribers" | "subscriptions", offset = 0, walked = 0) => ({
        collection,
        accountId: bob,
        movedToId: alice,
        offset,
        walked,
    });

    /** Whether `id` follows `to`: `true` if accepted, `false` if requested, or `undefined`. */
    const following = async (id: string, to: string) =>
        (await followsFrom(a, id, [to]))[0]?.accepted;

    const recorded = async () =>
        (await a.db.selectFrom("move_subscribers").select(["account_id", "host", "remote_id"])
            .orderBy("remote_id").execute()).map((row) => `${row.host}:${row.remote_id}`);

    /** The SubscribeAccepts that a.test sent to c.test. */
    const accepts = async () => {
        let count = 0;
        for (const request of network.transport.sent) {
            if (request.method !== "POST" || new URL(request.url).host !== "c.test") continue;
            if ((await request.clone().json()).type === "SubscribeAccept") count++;
        }

        return count;
    };

    /** Has `from` on c.test send a Subscribe to alice. */
    const subscribe = async (from: EvilInstance, id: string) => {
        const response = await from.send("https://a.test/.versia/v0.7/inbox", {
            body: {
                type: "Subscribe",
                created_at: network.clock.now().toISOString(),
                subscriber: `${from.domain}:${id}`,
                target: "a.test:alice",
                target_type: "User",
            },
        });
        assertEquals(response.status, 202);
        await network.drain();
    };

    return {
        network,
        a,
        b,
        c,
        alice,
        una,
        lena,
        bob,
        carol,
        dave,
        erin,
        frank,
        migrate,
        moveTo,
        serveCollection,
        asked,
        job,
        following,
        recorded,
        accepts,
        subscribe,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("only a remote account moving to a local one has its subscribers and subscriptions fetched", async () => {
    await using test = await open();
    const queued = async () =>
        (await test.a.db.selectFrom("jobs").select("payload").where("queue", "=", moveImportQueue)
            .execute()).map((row) => row.payload);
    const queue = (accountId: string, movedToId: string) => {
        const moved: AccountMoved = { type: "accounts.moved", accountId, movedToId };
        return test.a.transaction((tx) => queueMoveImports(tx, moved));
    };

    await queue(test.bob, test.carol);
    await queue(test.una, test.lena);
    await queue(test.una, test.bob);
    assertEquals(await queued(), []);

    await queue(test.bob, test.alice);
    await queue(test.bob, test.alice);
    assertEquals(await queued(), [test.job("subscribers"), test.job("subscriptions")]);
});

Deno.test("the accounts the old account followed are followed, except blocked ones and the account itself", async () => {
    await using test = await open();
    await insertBlock(test.a, test.alice, test.erin);
    await blockDomainFor(test.a, test.alice, "e.test");
    test.serveCollection("subscriptions", [
        "c.test:carol",
        "a.test:alice",
        "c.test:erin",
        "e.test:frank",
        "a.test:una",
        "a.test:lena",
        "c.test:nobody",
    ]);
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscriptions"));

    assertEquals(await test.following(test.alice, test.carol), false);
    assertEquals(await test.following(test.alice, test.una), true);
    assertEquals(await test.following(test.alice, test.lena), false);
    assertEquals(await test.following(test.alice, test.erin), undefined);
    assertEquals(await test.following(test.alice, test.frank), undefined);
    assertEquals(await test.following(test.alice, test.alice), undefined);
});

Deno.test("a move brings over at most so many subscriptions or subscribers", async () => {
    await using test = await open();
    test.serveCollection("subscriptions", ["c.test:carol", "c.test:dave", "c.test:erin"]);
    test.serveCollection("subscribers", ["c.test:carol", "c.test:dave", "c.test:erin"]);
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscriptions"), { subscribers: 1, subscriptions: 2 });
    await importCollection(test.a, test.job("subscribers"), { subscribers: 2, subscriptions: 1 });

    assertEquals(await test.following(test.alice, test.carol), false);
    assertEquals(await test.following(test.alice, test.dave), false);
    assertEquals(await test.following(test.alice, test.erin), undefined);
    assertEquals(await test.recorded(), ["c.test:carol", "c.test:dave"]);

    // A job that already walked its share does nothing.
    await importCollection(test.a, test.job("subscribers", 2, 2), {
        subscribers: 2,
        subscriptions: 1,
    });
    assertEquals(await test.recorded(), ["c.test:carol", "c.test:dave"]);
});

Deno.test("subscribers are recorded as of their fetch, and a pending request is accepted unless the follower is silenced", async () => {
    await using test = await open();
    assertEquals(await follow(test.a, test.carol, test.alice), "requested");
    assertEquals(await follow(test.a, test.dave, test.alice), "requested");
    await setSilencedAt(test.a, test.dave, test.network.clock.now());
    test.serveCollection("subscribers", [
        "c.test:carol",
        "c.test:dave",
        "c.test:erin",
        "c.test:unknown",
        "a.test:una",
    ]);
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscribers"));
    await importCollection(test.a, test.job("subscribers"));
    await deleteExpiredMoveSubscribers(test.a);

    assertEquals(await test.recorded(), [
        "c.test:carol",
        "c.test:dave",
        "c.test:erin",
        "c.test:unknown",
    ]);
    assertEquals(await test.following(test.carol, test.alice), true);
    assertEquals(await test.following(test.dave, test.alice), false);
    assertEquals(await test.following(test.erin, test.alice), undefined);
});

Deno.test("collections are fetched 40 references at a time, from the offset of the job", async () => {
    await using test = await open();
    const items = Array.from({ length: 85 }, (_, index) => `c.test:s${index}`);
    test.serveCollection("subscribers", items);
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscribers"));
    assertEquals(test.asked("subscribers"), [0, 40, 80]);
    assertEquals((await test.recorded()).length, 85);

    await importCollection(test.a, test.job("subscribers", 80, 80));
    assertEquals(test.asked("subscribers"), [0, 40, 80, 80]);
});

Deno.test("a subscribe from a recorded subscriber to a locked user is accepted once, from others it waits", async () => {
    await using test = await open();
    await test.moveTo(test.alice);
    test.serveCollection("subscribers", ["c.test:carol", "c.test:dave"]);
    await importCollection(test.a, test.job("subscribers"));
    await setSilencedAt(test.a, test.dave, test.network.clock.now());

    await test.subscribe(test.c, "carol");
    assertEquals(await test.following(test.carol, test.alice), true);
    assertEquals(await test.accepts(), 1);

    await test.subscribe(test.c, "dave");
    assertEquals(await test.following(test.dave, test.alice), false);

    await test.subscribe(test.c, "erin");
    assertEquals(await test.following(test.erin, test.alice), false);
    assertEquals(await test.accepts(), 1);
});

Deno.test("a subscribe to a locked user waits if the subscriber was recorded for another user or on another instance", async () => {
    await using test = await open();
    const row = (accountId: string, host: string) => ({
        account_id: accountId,
        host,
        remote_id: "carol",
        created_at: test.network.clock.now(),
    });
    await test.a.db.insertInto("move_subscribers")
        .values([row(test.lena, "c.test"), row(test.alice, "d.test")])
        .execute();

    await test.subscribe(test.c, "carol");

    assertEquals(await test.following(test.carol, test.alice), false);
});

Deno.test("local followers move to a locked local account, which accepts them unless they are silenced", async () => {
    await using test = await open();
    const sid = await createLocalAccount(test.a, "sid");
    await setSilencedAt(test.a, sid, test.network.clock.now());
    for (const id of [test.una, sid]) {
        assertEquals(await follow(test.a, id, test.bob), "requested");
        await test.a.db.updateTable("follows").set({ accepted: true })
            .where("follower_id", "=", id).execute();
    }

    await test.migrate();

    assertEquals(await test.following(test.una, test.alice), true);
    assertEquals(await test.following(sid, test.alice), false);
    assertEquals(await test.following(test.una, test.bob), undefined);
});

Deno.test("a move imports what bob's instance has, through the queue", async () => {
    await using test = await open();
    test.serveCollection("subscriptions", ["c.test:carol"]);
    test.serveCollection("subscribers", ["c.test:dave"]);

    await test.migrate();

    assertEquals(await test.following(test.alice, test.carol), false);
    assertEquals(await test.recorded(), ["c.test:dave"]);
});

Deno.test("a job past its 4 minutes queues the next offset, which carries on", async () => {
    await using test = await open();
    const advance = () => test.network.clock.advance(4 * 60_000);
    test.serveCollection("subscribers", ["c.test:carol", "c.test:dave", "c.test:erin"], {
        after: advance,
    });
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscribers"));

    assertEquals(await test.recorded(), ["c.test:carol"]);
    const queued = await test.a.db.selectFrom("jobs").select("payload")
        .where("queue", "=", moveImportQueue).execute();
    assertEquals(queued.map((row) => row.payload), [test.job("subscribers", 1, 1)]);

    await test.network.drain();
    assertEquals(await test.recorded(), ["c.test:carol", "c.test:dave", "c.test:erin"]);
});

Deno.test("a subscription fetched as the 4 minutes end is still followed", async () => {
    await using test = await open();
    const advance = () => test.network.clock.advance(4 * 60_000);
    test.serveCollection("subscriptions", ["c.test:gina", "c.test:dave"], { after: advance });
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscriptions"));

    const gina = await findRemoteAccountAt(test.a, "c.test", "gina");
    assertExists(gina);
    assertEquals(await test.following(test.alice, gina.id), false);
    assertEquals(await test.following(test.alice, test.dave), undefined);
});

Deno.test("a job that runs out of time between pages queues the offset after the last one", async () => {
    await using test = await open();
    const advance = () => test.network.clock.advance(4 * 60_000);
    test.serveCollection("subscribers", ["c.test:carol", "c.test:dave"], {
        after: advance,
        perPage: 1,
    });
    await test.moveTo(test.alice);

    await importCollection(test.a, test.job("subscribers"));

    assertEquals(await test.recorded(), ["c.test:carol"]);
    const queued = await test.a.db.selectFrom("jobs").select("payload")
        .where("queue", "=", moveImportQueue).execute();
    assertEquals(queued.map((row) => row.payload), [test.job("subscribers", 1, 1)]);
});

Deno.test("a gone collection ends the walk, and a failing one is thrown", async () => {
    await using test = await open();
    await test.moveTo(test.alice);
    const serve = test.network.transport.servers.get("b.test");
    assertExists(serve);
    let status = 410;
    test.network.transport.servers.set("b.test", (request) =>
        new URL(request.url).pathname === path("bob", "subscribers")
            ? Promise.resolve(new Response(null, { status }))
            : serve(request));

    await importCollection(test.a, test.job("subscribers"));
    assertEquals(test.asked("subscribers"), [0]);
    status = 404;
    await importCollection(test.a, test.job("subscribers"));
    status = 500;
    await assertRejects(() => importCollection(test.a, test.job("subscribers")), Error);
    assertEquals(await test.recorded(), []);
});

Deno.test("a page that isn't references is a permanent failure", async () => {
    await using test = await open();
    await test.moveTo(test.alice);
    test.b.serve(path("bob", "subscribers"), { items: "no" });

    await assertRejects(
        () => importCollection(test.a, test.job("subscribers")),
        PermanentFailure,
    );
    await assertRejects(
        () => moveImportHandler(test.a, { payload: { collection: "x" } } as never),
        PermanentFailure,
    );
});

Deno.test("a job does nothing if the move was cancelled or changed, or an account or instance is gone", async () => {
    await using test = await open();
    test.serveCollection("subscribers", ["c.test:carol"]);
    const run = (movedToId: string, accountId = test.bob) =>
        importCollection(test.a, { ...test.job("subscribers"), accountId, movedToId });

    // Not moved, or moved to another account.
    await run(test.alice);
    await test.moveTo(test.carol);
    await run(test.alice);
    // Moved to a remote account, or from a local one.
    await run(test.carol);
    await test.moveTo(test.alice);
    await run(test.alice, test.una);
    // Accounts that are gone.
    await run("gone");
    await run(test.alice, "gone");
    // An instance that is blocked.
    await blockDomain(test.a, "b.test");
    await run(test.alice);

    assertEquals(test.asked("subscribers"), []);
    assertEquals(await test.recorded(), []);
});

Deno.test("subscribers recorded 30 days ago are deleted, newer ones aren't", async () => {
    await using test = await open();
    const at = (ms: number, id: string) => ({
        account_id: test.alice,
        host: "c.test",
        remote_id: id,
        created_at: new Date(test.network.clock.now().getTime() - ms),
    });
    const month = 30 * 24 * 3_600_000;
    await test.a.db.insertInto("move_subscribers")
        .values([
            at(month, "old1"),
            at(month + 1, "old2"),
            at(month + 2, "old3"),
            at(month - 1, "new"),
        ])
        .execute();

    await deleteExpiredMoveSubscribers(test.a, 2);

    assertEquals(await test.recorded(), ["c.test:new"]);
});

Deno.test("a recorded subscriber goes with the account it was recorded for", async () => {
    await using test = await open();
    await test.a.db.insertInto("move_subscribers")
        .values({
            account_id: test.alice,
            host: "c.test",
            remote_id: "carol",
            created_at: test.network.clock.now(),
        })
        .execute();

    await test.a.db.deleteFrom("accounts").where("id", "=", test.alice).execute();

    assertEquals(await test.recorded(), []);
});
