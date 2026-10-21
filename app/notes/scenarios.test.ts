/**
 * Following and notes end to end, between complete instances, through the client API: who is
 * sent what, who may fetch it, and edits reaching everyone who has it.
 * @module
 */
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { fetchSigned } from "../federation/request.ts";
import { createNetwork, type Instance, type Network } from "../testing/network.ts";
import { findRemoteNoteAt } from "./note_queries.ts";

/** Calls `instance`'s client API as `accountId`, with a JSON body if there is one. */
const clientOf = async (instance: Instance, accountId: string) => {
    const authorization = `Bearer ${await tokenFor(instance.ctx, accountId)}`;

    return async (method: string, path: string, body?: Record<string, unknown>) => {
        const response = await instance.app.request(path, {
            method,
            headers: body === undefined
                ? { authorization }
                : { authorization, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };
};

type Client = Awaited<ReturnType<typeof clientOf>>;

/** Has `client` look up `acct` and follow them. Returns the id their instance gives them. */
const follow = async (client: Client, acct: string) => {
    const found = await client("GET", `/api/v1/accounts/lookup?acct=${acct}`);
    assertEquals(found.status, 200, acct);
    assertEquals((await client("POST", `/api/v1/accounts/${found.body.id}/follow`)).status, 200);

    return found.body.id as string;
};

/** How many times each host was sent an entity of `type`, from the `from`th request on. */
const deliveries = async (network: Network, type: string, from: number) => {
    const hosts: Record<string, number> = {};
    for (const request of network.transport.sent.slice(from)) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/.versia/v0.6/inbox") continue;
        if ((await request.clone().json()).type !== type) continue;

        hosts[url.host] = (hosts[url.host] ?? 0) + 1;
    }

    return hosts;
};

/**
 * Alice on a.test; bob and bea on b.test and carol on c.test, who follow her; dave on d.test, who
 * doesn't; and erin on e.test, whom she only mentions.
 */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test", "c.test", "d.test", "e.test"]);
    const { instances } = network;
    const alice = await clientOf(
        instances["a.test"],
        await createLocalAccount(instances["a.test"].ctx, "alice"),
    );

    const users: Record<string, Client> = { alice };
    for (
        const [id, domain] of [["bob", "b"], ["bea", "b"], ["carol", "c"], ["dave", "d"], [
            "erin",
            "e",
        ]]
    ) {
        const instance = instances[`${domain}.test`];
        users[id] = await clientOf(instance, await createLocalAccount(instance.ctx, id));
    }
    for (const id of ["bob", "bea", "carol"]) await follow(users[id], "alice@a.test");
    await network.drain();

    /** Has alice post `status`, delivers it, and returns it with who was sent it, and how often. */
    const post = async (status: string, visibility: string) => {
        const from = network.transport.sent.length;
        const posted = await alice("POST", "/api/v1/statuses", { status, visibility });
        assertEquals(posted.status, 200);
        await network.drain();

        return { id: posted.body.id as string, sent: await deliveries(network, "Note", from) };
    };

    /** The status `user` sees on their own instance for alice's note `id`, found by its URI. */
    const seen = async (user: string, id: string) => {
        const statuses = await users[user]("GET", "/api/v1/timelines/home");
        return statuses.body.find((status: { uri: string }) =>
            status.uri === `https://a.test/.versia/v0.6/entities/Note/${id}`
        );
    };

    return {
        network,
        alice,
        users,
        post,
        seen,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("a locked user is asked to be followed, and accepts or rejects each request", async () => {
    await using network = await createNetwork(["a.test", "b.test", "c.test"]);
    const { instances } = network;
    const bob = await clientOf(
        instances["b.test"],
        await createLocalAccount(instances["b.test"].ctx, "bob"),
    );
    const alice = await clientOf(
        instances["a.test"],
        await createLocalAccount(instances["a.test"].ctx, "alice"),
    );
    const carol = await clientOf(
        instances["c.test"],
        await createLocalAccount(instances["c.test"].ctx, "carol"),
    );
    assertEquals(
        (await bob("PATCH", "/api/v1/accounts/update_credentials", { locked: true })).status,
        200,
    );

    const bobOnA = await follow(alice, "bob@b.test");
    const bobOnC = await follow(carol, "bob@b.test");
    await network.drain();

    const requests = await bob("GET", "/api/v1/follow_requests");
    const asking = new Map<string, string>(
        requests.body.map((account: { acct: string; id: string }) => [account.acct, account.id]),
    );
    assertEquals([...asking.keys()].toSorted(), ["alice@a.test", "carol@c.test"]);

    await bob("POST", `/api/v1/follow_requests/${asking.get("alice@a.test")}/authorize`);
    await bob("POST", `/api/v1/follow_requests/${asking.get("carol@c.test")}/reject`);
    await network.drain();

    const relationship = async (client: Client, id: string) => {
        const [found] = (await client("GET", `/api/v1/accounts/relationships?id=${id}`)).body;
        return [found.following, found.requested];
    };
    assertEquals(await relationship(alice, bobOnA), [true, false]);
    assertEquals(await relationship(carol, bobOnC), [false, false]);
    assertEquals((await bob("GET", "/api/v1/accounts/verify_credentials")).body.followers_count, 1);
    assertEquals((await bob("GET", "/api/v1/follow_requests")).body, []);
});

Deno.test("a note reaches each instance it is shown on once, and no other", async () => {
    await using test = await open();

    const everyone = await test.post("Hi", "public");
    assertEquals(everyone.sent, { "b.test": 1, "c.test": 1 });
    for (const user of ["bob", "bea", "carol"]) {
        assertExists(await test.seen(user, everyone.id), user);
    }

    const followers = await test.post("Friends only", "private");
    assertEquals(followers.sent, { "b.test": 1, "c.test": 1 });
    assertEquals((await test.seen("bob", followers.id))?.visibility, "private");

    const direct = await test.post("Psst @erin@e.test", "direct");
    assertEquals(direct.sent, { "e.test": 1 });
    assertEquals(await test.seen("bob", direct.id), undefined);
    // Erin's instance keeps it, though she doesn't follow alice, so it isn't on her home.
    const kept = await findRemoteNoteAt(test.network.instances["e.test"].ctx, "a.test", direct.id);
    assertEquals(kept?.visibility, "direct");
    assertEquals((await test.users.erin("GET", "/api/v1/timelines/home")).body, []);
});

Deno.test("a note can be fetched only by the instances it is shown on", async () => {
    await using test = await open();
    const direct = await test.post("Psst @erin@e.test", "direct");
    const followers = await test.post("Friends only", "private");
    const fetched = async (domain: string, id: string) => {
        const url = new URL(`https://a.test/.versia/v0.6/entities/Note/${id}`);
        return (await fetchSigned(test.network.instances[domain].ctx, url)).status;
    };

    assertEquals(await fetched("e.test", direct.id), 200);
    assertEquals(await fetched("d.test", direct.id), 404);
    assertEquals(await fetched("b.test", direct.id), 404);
    assertEquals(await fetched("c.test", followers.id), 200);
    assertEquals(await fetched("d.test", followers.id), 404);
});

Deno.test("an edit reaches every instance that has the note, with its history", async () => {
    await using test = await open();
    const note = await test.post("Hi", "public");
    const from = test.network.transport.sent.length;

    const edited = await test.alice("PUT", `/api/v1/statuses/${note.id}`, { status: "Hi *all*" });
    assertEquals(edited.status, 200);
    await test.network.drain();

    assertEquals(await deliveries(test.network, "Note", from), { "b.test": 1, "c.test": 1 });
    const status = await test.seen("carol", note.id);
    assertStringIncludes(status?.content, "Hi *all*");
    assertEquals(status?.edited_at, test.network.clock.now().toISOString());

    const history = await test.users.carol("GET", `/api/v1/statuses/${status?.id}/history`);
    assertEquals(history.body.map((version: { content: string }) => version.content), [
        "<p>Hi</p>",
        "<p>Hi *all*</p>",
    ]);
});

Deno.test("a deleted note is gone from every instance that had it", async () => {
    await using test = await open();
    const note = await test.post("Hi", "public");
    const from = test.network.transport.sent.length;

    assertEquals((await test.alice("DELETE", `/api/v1/statuses/${note.id}`)).status, 200);
    await test.network.drain();

    assertEquals(await deliveries(test.network, "Delete", from), { "b.test": 1, "c.test": 1 });
    for (const user of ["bob", "carol"]) {
        assertEquals(await test.seen(user, note.id), undefined, user);
    }
});
