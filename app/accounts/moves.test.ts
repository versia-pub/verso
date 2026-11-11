import { assertEquals, assertExists } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import type { DomainEvent } from "../kernel/context.ts";
import { subscribers } from "../services.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { findAccount } from "./account_queries.ts";
import { suspend } from "../moderation/suspensions.ts";
import { migrationType } from "./moves.ts";
import { createLocalAccount } from "./testing.ts";

/** A week, how long after moving an account can't move again. */
const week = 7 * 24 * 60 * 60_000;

/** A user `id`, with `migration` as its migration extension, if any. */
const user = (id: string, migration?: { previous?: string; new?: string }) => ({
    type: "User",
    id,
    created_at: "2026-01-01T00:00:00Z",
    username: id,
    fields: [],
    manually_approves_followers: false,
    indexable: true,
    ...(migration === undefined ? {} : { extensions: { "pub.versia:migration": migration } }),
});

/**
 * a.test, with alice, and b.test and c.test, which send whatever they are told to. b.test has bob,
 * whom a.test has, and c.test has bob2 and bob3, which say they moved from bob, carol, which says
 * nothing, and dave, which says it moved from someone else.
 */
const open = async () => {
    const events: DomainEvent[] = [];
    const network = await createNetwork(["a.test"], {
        subscribers: [...subscribers, (_, event) => {
            events.push(event);
            return Promise.resolve();
        }],
    });
    const a = network.instances["a.test"].ctx;
    const app = network.instances["a.test"].app;
    const b = await addEvilInstance(network, "b.test", ["pub.versia:migration"]);
    const c = await addEvilInstance(network, "c.test", ["pub.versia:migration"]);
    const path = (id: string) => `/.versia/v0.6/entities/User/${id}`;

    b.serve(path("bob"), user("bob"));
    for (const id of ["bob2", "bob3"]) c.serve(path(id), user(id, { previous: "b.test:bob" }));
    c.serve(path("carol"), user("carol"));
    c.serve(path("dave"), user("dave", { previous: "b.test:someone" }));

    const alice = await createLocalAccount(a, "alice");
    const bob = await a.federation.resolve(a, { host: "b.test", id: "bob" }, "User");
    assertExists(bob);

    /** Has `from` send `entity` to a.test, and a.test receive it. */
    const send = async (entity: object, from = b) => {
        assertEquals(
            (await from.send("https://a.test/.versia/v0.6/inbox", { body: entity })).status,
            202,
        );
        await network.drain();
    };

    /** Has `from` say bob moved to `destination`. */
    const migrate = async (destination: string, from = b) =>
        await send({
            type: "pub.versia:migration/Migration",
            created_at: network.clock.now().toISOString(),
            author: "b.test:bob",
            destination,
        }, from);

    /** The id a.test has for the account `id` on c.test. */
    const idOf = async (id: string) => {
        const found = await a.federation.resolve(a, { host: "c.test", id }, "User");
        assertExists(found);
        return found;
    };

    /** The account a.test has as bob moved to, as its API says, or `undefined` if none. */
    const movedTo = async (id = bob) => {
        const response = await app.request(`/api/v1/accounts/${id}`);
        assertEquals(response.status, 200);
        return (await response.json()).moved;
    };

    return {
        network,
        events,
        a,
        app,
        b,
        c,
        path,
        alice,
        bob,
        send,
        migrate,
        idOf,
        movedTo,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a user that moved to an account saying it moved from it is shown as moved there", async () => {
    await using test = await open();
    const moves = () => test.events.filter((event) => event.type === "accounts.moved") as unknown[];

    await test.migrate("c.test:bob2");
    const bob2 = await test.idOf("bob2");
    const moved = await test.movedTo();
    assertEquals([moved.id, moved.acct, moved.moved], [bob2, "bob2@c.test", undefined]);
    assertEquals(await test.movedTo(bob2), undefined);
    const listed = await test.app.request(`/api/v1/accounts?id[]=${test.bob}&id[]=${bob2}`);
    assertEquals(
        (await listed.json()).map((account: { moved?: { acct: string } }) => account.moved?.acct),
        ["bob2@c.test", undefined],
    );
    assertEquals(moves(), [{ type: "accounts.moved", accountId: test.bob, movedToId: bob2 }]);

    // Received again, it changes nothing.
    const before = await findAccount(test.a, test.bob);
    test.network.clock.advance(week);
    await test.migrate("c.test:bob2");
    assertEquals((await findAccount(test.a, test.bob))?.moved_at, before?.moved_at);
    assertEquals(moves().length, 1);
});

Deno.test("a user isn't moved to an account that doesn't say it moved from it, or to itself", async () => {
    await using test = await open();
    test.b.serve(test.path("bob"), user("bob", { previous: "b.test:bob" }));
    test.c.serve(test.path("erin"), user("erin", { previous: "other.test:bob" }));
    // a.test's own id for bob2, fetched just now, which only names a local account there.
    const local = `a.test:${await test.idOf("bob2")}`;

    for (
        const destination of [
            local,
            "c.test:carol",
            "c.test:dave",
            "c.test:erin",
            "c.test:missing",
            "b.test:bob",
        ]
    ) {
        await test.migrate(destination);
        assertEquals(await test.movedTo(), undefined, destination);
        test.network.clock.advance(1);
    }
});

Deno.test("only a user's own instance moves it", async () => {
    await using test = await open();

    await test.migrate("c.test:bob2", test.c);
    assertEquals(await test.movedTo(), undefined);
});

Deno.test("a user moves only to an account fetched again since, as it is now", async () => {
    await using test = await open();
    await test.idOf("bob2");
    test.c.serve(test.path("bob2"), user("bob2"));

    await test.migrate("c.test:bob2");
    assertEquals(await test.movedTo(), undefined);

    // Nor if it can't be fetched, though Verso has it saying it moved from bob.
    test.c.serve(test.path("bob2"), user("bob2", { previous: "b.test:bob" }));
    await test.a.federation.resolve(test.a, { host: "c.test", id: "bob2" }, "User", undefined, 0);
    test.network.transport.down.add("c.test");
    test.network.clock.advance(1);
    await test.migrate("c.test:bob2");
    assertEquals(await test.movedTo(), undefined);

    test.network.transport.down.delete("c.test");
    test.network.clock.advance(1);
    await test.migrate("c.test:bob2");
    assertEquals((await test.movedTo()).acct, "bob2@c.test");
});

Deno.test("a user isn't moved to a suspended, deleted or moved account", async () => {
    await using test = await open();
    const bob2 = await test.idOf("bob2");
    const now = test.network.clock.now();

    for (
        const change of [{ suspended_at: now }, { deleted_at: now }, { moved_to_account_id: bob2 }]
    ) {
        test.network.clock.advance(1);
        const bob3 = await test.idOf("bob3");
        await test.a.db.updateTable("accounts").set(change).where("id", "=", bob3).execute();
        await test.migrate("c.test:bob3");
        assertEquals(await test.movedTo(), undefined, Object.keys(change)[0]);
        await test.a.db.updateTable("accounts")
            .set({ suspended_at: null, deleted_at: null, moved_to_account_id: null })
            .where("id", "=", bob3)
            .execute();
    }
});

Deno.test("a user moves again only a week after it last did", async () => {
    await using test = await open();
    await test.migrate("c.test:bob2");

    test.network.clock.advance(week - 1);
    await test.migrate("c.test:bob3");
    assertEquals((await test.movedTo()).acct, "bob2@c.test");

    test.network.clock.advance(1);
    await test.migrate("c.test:bob3");
    assertEquals((await test.movedTo()).acct, "bob3@c.test");
});

Deno.test("a user saying it moved is moved, and stays so once it no longer says it", async () => {
    await using test = await open();

    await test.send(user("bob", { new: "c.test:bob2" }));
    assertEquals((await test.movedTo()).acct, "bob2@c.test");

    await test.send(user("bob"));
    assertEquals((await test.movedTo()).acct, "bob2@c.test");
});

Deno.test("a user fetched saying it moved is moved", async () => {
    await using test = await open();
    test.b.serve(test.path("bob"), user("bob", { new: "c.test:bob2" }));

    await test.a.federation.resolve(test.a, { host: "b.test", id: "bob" }, "User", undefined, 0);
    assertEquals((await test.movedTo()).acct, "bob2@c.test");
});

Deno.test("a user saying it moved from another is saved as such, until it no longer says it", async () => {
    await using test = await open();
    const bob2 = await test.idOf("bob2");
    const previous = async () => {
        const row = await findAccount(test.a, bob2);
        return [row?.previous_host, row?.previous_id];
    };
    assertEquals(await previous(), ["b.test", "bob"]);

    await test.send(user("bob2", { previous: "someone" }), test.c);
    assertEquals(await previous(), ["c.test", "someone"]);

    await test.send(user("bob2"), test.c);
    assertEquals(await previous(), [null, null]);
});

Deno.test("an account that moved can't be followed", async () => {
    await using test = await open();
    await test.migrate("c.test:bob2");
    const token = await tokenFor(test.a, test.alice);

    const response = await test.app.request(`/api/v1/accounts/${test.bob}/follow`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
    });
    assertEquals(response.status, 403);
    await response.body?.cancel();
});

Deno.test("a suspended user that moved is shown as moved nowhere", async () => {
    await using test = await open();
    await test.migrate("c.test:bob2");

    await suspend(test.a, test.bob);
    assertEquals(await test.movedTo(), null);
});

Deno.test("a Migration received without being prepared moves no one", async () => {
    await using test = await open();
    await test.idOf("bob2");
    const sender = { domain: "b.test", instanceId: "b.test", fetched: false, backfill: false };

    await test.a.transaction((tx) =>
        migrationType.receive(tx, {
            type: "pub.versia:migration/Migration",
            created_at: "2026-01-01T00:00:00Z",
            author: "b.test:bob",
            destination: "c.test:bob2",
        }, sender)
    );
    assertEquals(await test.movedTo(), undefined);
});
