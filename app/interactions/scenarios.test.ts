/**
 * Interactions end to end, between complete instances, through the client API: likes, shares and
 * reactions reaching the note's instance and the sharer's followers, blocks and mutes that tell no
 * one, and pinned notes other instances can fetch.
 * @module
 */
import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { fetchSigned } from "../federation/request.ts";
import { type Client, clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork } from "../testing/network.ts";

/**
 * Alice on a.test; bob on b.test and carol on c.test, who follow her; erin on e.test, who follows
 * bob; and dave on d.test, whom alice follows.
 */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test", "c.test", "d.test", "e.test"]);
    const users: Record<string, Client> = {};
    for (
        const [id, domain] of [["alice", "a"], ["bob", "b"], ["carol", "c"], ["dave", "d"], [
            "erin",
            "e",
        ]]
    ) {
        const instance = network.instances[`${domain}.test`];
        users[id] = await clientOf(instance, await createLocalAccount(instance.ctx, id));
    }
    for (const id of ["bob", "carol"]) await followAddress(users[id], "alice@a.test");
    await followAddress(users.erin, "bob@b.test");
    await followAddress(users.alice, "dave@d.test");
    await network.drain();

    /** Has `user` post a public status, delivers it, and returns its id. */
    const post = async (user: string, status: string) => {
        const posted = await users[user]("POST", "/api/v1/statuses", { status });
        assertEquals(posted.status, 200);
        await network.drain();

        return posted.body.id as string;
    };

    /** The status `user` has on their own home timeline for alice's note `id`, if any. */
    const seen = async (user: string, id: string) => {
        const uri = `https://a.test/.versia/v0.6/entities/Note/${id}`;
        const statuses = await users[user]("GET", "/api/v1/timelines/home");
        return statuses.body.find((status: { uri: string; reblog: { uri: string } | null }) =>
            status.uri === uri || status.reblog?.uri === uri
        );
    };

    /** How alice's note `id` looks to her: its counts, who liked and shared it, and reactions. */
    const onA = async (id: string) => {
        const accts = async (list: string) =>
            (await users.alice("GET", `/api/v1/statuses/${id}/${list}`)).body.map((
                account: { acct: string },
            ) => account.acct);
        const status = (await users.alice("GET", `/api/v1/statuses/${id}`)).body;
        const reactions = (await users.alice("GET", `/api/v1/statuses/${id}/reactions`)).body;

        return {
            counts: [status.favourites_count, status.reblogs_count],
            liked: await accts("favourited_by"),
            shared: await accts("reblogged_by"),
            reactions: reactions.map((group: { name: string; count: number }) => [
                group.name,
                group.count,
            ]),
        };
    };

    return {
        network,
        users,
        post,
        seen,
        onA,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("a like, share and reaction reach the note's instance, and the share the sharer's followers", async () => {
    await using test = await open();
    const id = await test.post("alice", "Hi");
    const onB = await test.seen("bob", id);
    assertExists(onB);
    const path = `/api/v1/statuses/${onB.id}`;

    assertEquals((await test.users.bob("POST", `${path}/favourite`)).status, 200);
    assertEquals((await test.users.bob("POST", `${path}/reblog`)).status, 200);
    assertEquals((await test.users.bob("PUT", `${path}/reactions/🎉`)).status, 201);
    await test.network.drain();

    assertEquals(await test.onA(id), {
        counts: [1, 1],
        liked: ["bob@b.test"],
        shared: ["bob@b.test"],
        reactions: [["🎉", 1]],
    });
    // Erin follows bob, not alice, so she sees the note through his share.
    const shared = await test.seen("erin", id);
    assertEquals(shared?.account.acct, "bob@b.test");
    assertEquals(shared?.reblog.account.acct, "alice@a.test");

    await test.users.bob("POST", `${path}/unfavourite`);
    await test.users.bob("POST", `${path}/unreblog`);
    await test.users.bob("DELETE", `${path}/reactions/🎉`);
    await test.network.drain();

    assertEquals(await test.onA(id), { counts: [0, 0], liked: [], shared: [], reactions: [] });
    assertEquals(await test.seen("erin", id), undefined);
});

Deno.test("blocks, mutes and domain blocks tell no one, and only change what the viewer sees", async () => {
    await using test = await open();
    const { users } = test;
    const id = await test.post("alice", "Hi");
    const lookup = async (acct: string) =>
        (await users.alice("GET", `/api/v1/accounts/lookup?acct=${acct}`)).body.id as string;
    const bob = await lookup("bob@b.test");
    const carol = await lookup("carol@c.test");
    const from = test.network.transport.sent.length;

    assertEquals((await users.alice("POST", `/api/v1/accounts/${bob}/block`)).status, 200);
    assertEquals((await users.alice("POST", `/api/v1/accounts/${carol}/mute`)).status, 200);
    assertEquals(
        (await users.alice("POST", "/api/v1/domain_blocks", { domain: "d.test" })).status,
        200,
    );
    await test.network.drain();
    assertEquals(test.network.transport.sent.length, from);

    // Bob still follows her and sees her notes, and his like still reaches her instance.
    const onB = await test.seen("bob", id);
    assertExists(onB);
    await users.bob("POST", `/api/v1/statuses/${onB.id}/favourite`);
    const onC = await test.seen("carol", id);
    await users.carol("POST", `/api/v1/statuses/${onC.id}/favourite`);
    await test.network.drain();

    assertEquals((await test.onA(id)).liked, ["carol@c.test"]);
    const [relationship] =
        (await users.alice("GET", `/api/v1/accounts/relationships?id=${bob}`)).body;
    assertEquals([relationship.blocking, relationship.followed_by], [true, true]);

    // Dave's notes, and the shares of hers by those she blocks, don't reach her home.
    await test.post("dave", "Hello");
    await users.bob("POST", `/api/v1/statuses/${onB.id}/reblog`);
    await test.network.drain();
    const home = (await users.alice("GET", "/api/v1/timelines/home")).body;
    assertEquals(home.map((status: { account: { acct: string } }) => status.account.acct), [
        "alice",
    ]);

    assertEquals(
        (await users.alice("DELETE", "/api/v1/domain_blocks", { domain: "d.test" })).status,
        200,
    );
    assertEquals(
        (await users.alice("GET", "/api/v1/timelines/home")).body[0].account.acct,
        "dave@d.test",
    );
});

Deno.test("a pinned note is in its author's featured notes for other instances", async () => {
    await using test = await open();
    const first = await test.post("alice", "First");
    const second = await test.post("alice", "Second");
    for (const id of [first, second]) {
        assertEquals((await test.users.alice("POST", `/api/v1/statuses/${id}/pin`)).status, 200);
    }
    const b = test.network.instances["b.test"].ctx;
    const fetched = async (url: string) => {
        const response = await fetchSigned(b, new URL(url));
        assertEquals(response.status, 200, url);
        return JSON.parse(new TextDecoder().decode(response.body));
    };

    const alice = await test.users.alice("GET", "/api/v1/accounts/verify_credentials");
    const featured = await fetched(
        `https://a.test/.versia/v0.6/entities/User/${alice.body.id}/collections/featured`,
    );
    assertEquals(featured.total, 2);
    assertEquals(
        featured.items.map((item: string | { id: string }) =>
            typeof item === "string" ? item : item.id
        ),
        [second, first],
    );
});
