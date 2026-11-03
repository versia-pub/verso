/**
 * Polls end to end, between complete instances, through the client API: votes reaching the poll's
 * instance, and its results reaching the voters' when it ends.
 * @module
 */
import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { type Client, clientOf, followAddress } from "../testing/clients.ts";
import { createNetwork } from "../testing/network.ts";
import { endPolls } from "./ending.ts";

/** Alice on a.test and bob on b.test, who follow each other. */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const users: Record<string, Client> = {};
    for (const [id, domain] of [["alice", "a.test"], ["bob", "b.test"]]) {
        const instance = network.instances[domain];
        users[id] = await clientOf(instance, await createLocalAccount(instance.ctx, id));
    }
    await followAddress(users.alice, "bob@b.test");
    await followAddress(users.bob, "alice@a.test");
    await network.drain();

    /** Has `user` ask which colour, in a poll of an hour, and returns the status's id. */
    const ask = async (user: string, multiple: boolean) => {
        const posted = await users[user]("POST", "/api/v1/statuses", {
            status: "Which?",
            poll: { options: ["Red", "Blue", "Green"], expires_in: 3600, multiple },
        });
        assertEquals(posted.status, 200);
        await network.drain();

        return posted.body.id as string;
    };

    /** The poll of the status `uri`, as `user` sees it from their home timeline. */
    const pollOf = async (user: string, uri: string) => {
        const statuses = (await users[user]("GET", "/api/v1/timelines/home")).body;
        const status = statuses.find((each: { uri: string }) => each.uri === uri);
        assertExists(status?.poll, `${user} has no poll`);
        return status.poll;
    };

    /** Has `user` vote for `choices` in the poll of the status `uri`. */
    const vote = async (user: string, uri: string, choices: number[]) => {
        const poll = await pollOf(user, uri);
        const voted = await users[user]("POST", `/api/v1/polls/${poll.id}/votes`, { choices });
        assertEquals(voted.status, 200);
        await network.drain();
    };

    /** Ends the polls on `domain` that ended by now, and delivers what that sends. */
    const end = async (domain: string) => {
        await endPolls(network.instances[domain].ctx);
        await network.drain();
    };

    const counts = (poll: { options: { votes_count: number }[] }) =>
        poll.options.map((option) => option.votes_count);

    return {
        network,
        users,
        ask,
        pollOf,
        vote,
        end,
        counts,
        [Symbol.asyncDispose]: () => network[Symbol.asyncDispose](),
    };
};

Deno.test("a vote reaches the poll's instance, and the results the voter's when it ends", async () => {
    await using test = await open();
    const id = await test.ask("alice", true);
    const uri = `https://a.test/.versia/v0.6/entities/Note/${id}`;

    await test.vote("bob", uri, [0, 2]);

    const onA = (await test.users.alice("GET", `/api/v1/statuses/${id}`)).body.poll;
    assertEquals([test.counts(onA), onA.voters_count], [[1, 0, 1], 1]);
    // Bob's own votes count on b.test until alice's instance says otherwise.
    const onB = await test.pollOf("bob", uri);
    assertEquals([test.counts(onB), onB.voted, onB.own_votes], [[1, 0, 1], true, [0, 2]]);

    test.network.clock.advance(3600_000);
    await test.end("a.test");

    const ended = await test.pollOf("bob", uri);
    assertEquals([test.counts(ended), ended.expired], [[1, 0, 1], true]);
});

Deno.test("votes in a remote poll are counted by its instance, and others' reach the voter's when it ends", async () => {
    await using test = await open();
    const id = await test.ask("bob", false);
    const uri = `https://b.test/.versia/v0.6/entities/Note/${id}`;

    await test.vote("alice", uri, [1]);
    // Bob asked, so he can't vote, but someone else on b.test can.
    const carol = await clientOf(
        test.network.instances["b.test"],
        await createLocalAccount(test.network.instances["b.test"].ctx, "carol"),
    );
    const poll = (await carol("GET", `/api/v1/statuses/${id}`)).body.poll;
    assertEquals(
        (await carol("POST", `/api/v1/polls/${poll.id}/votes`, { choices: [1] })).status,
        200,
    );

    const onB = (await test.users.bob("GET", `/api/v1/statuses/${id}`)).body.poll;
    assertEquals([test.counts(onB), onB.voters_count], [[0, 2, 0], 2]);
    assertEquals(test.counts(await test.pollOf("alice", uri)), [0, 1, 0]);

    test.network.clock.advance(3600_000);
    await test.end("b.test");

    assertEquals(test.counts(await test.pollOf("alice", uri)), [0, 2, 0]);
});

/** How many times `domain` was asked for the status `id`. */
const fetches = (network: Awaited<ReturnType<typeof open>>["network"], id: string) =>
    network.transport.sent.filter((request) =>
        new URL(request.url).pathname === `/.versia/v0.6/entities/Note/${id}`
    ).length;

Deno.test("votes in a local poll reach its followers' instances a few minutes after the first", async () => {
    await using test = await open();
    const a = test.network.instances["a.test"];
    const carol = await clientOf(a, await createLocalAccount(a.ctx, "carol"));
    const id = await test.ask("alice", false);
    const uri = `https://a.test/.versia/v0.6/entities/Note/${id}`;
    const poll = (await carol("GET", `/api/v1/statuses/${id}`)).body.poll;
    const dave = await clientOf(a, await createLocalAccount(a.ctx, "dave"));

    assertEquals(
        (await carol("POST", `/api/v1/polls/${poll.id}/votes`, { choices: [1] })).status,
        200,
    );
    test.network.clock.advance(2 * 60_000);
    assertEquals(
        (await dave("POST", `/api/v1/polls/${poll.id}/votes`, { choices: [1] })).status,
        200,
    );
    await test.network.drain();
    assertEquals(test.counts(await test.pollOf("bob", uri)), [0, 0, 0]);

    test.network.clock.advance(60_000);
    await test.network.drain();
    assertEquals(test.counts(await test.pollOf("bob", uri)), [0, 2, 0]);

    // A vote after that starts another wait.
    const erin = await clientOf(a, await createLocalAccount(a.ctx, "erin"));
    assertEquals(
        (await erin("POST", `/api/v1/polls/${poll.id}/votes`, { choices: [0] })).status,
        200,
    );
    test.network.clock.advance(3 * 60_000);
    await test.network.drain();
    assertEquals(test.counts(await test.pollOf("bob", uri)), [1, 2, 0]);
});

Deno.test("a remote poll opened by a user is fetched again once it is a minute old, until it has ended", async () => {
    await using test = await open();
    const b = test.network.instances["b.test"];
    const carol = await clientOf(b, await createLocalAccount(b.ctx, "carol"));
    const id = await test.ask("bob", false);
    const uri = `https://b.test/.versia/v0.6/entities/Note/${id}`;
    const poll = (await carol("GET", `/api/v1/statuses/${id}`)).body.poll;
    assertEquals(
        (await carol("POST", `/api/v1/polls/${poll.id}/votes`, { choices: [2] })).status,
        200,
    );

    /** Has alice open the poll, and returns its counts as she saw them, and the fetches it made. */
    const view = async () => {
        const before = fetches(test.network, id);
        const shown = await test.pollOf("alice", uri);
        const got = await test.users.alice("GET", `/api/v1/polls/${shown.id}`);
        assertEquals(got.status, 200);
        await test.network.drain();

        return [test.counts(got.body), fetches(test.network, id) - before];
    };

    assertEquals(await view(), [[0, 0, 0], 0]);

    test.network.clock.advance(60_000);
    assertEquals(await view(), [[0, 0, 0], 1]);
    assertEquals(await view(), [[0, 0, 1], 0]);

    // bob's instance sends the votes so far when the poll ends, which alice's keeps as final.
    test.network.clock.advance(3600_000);
    await test.end("b.test");
    test.network.clock.advance(60_000);
    assertEquals(await view(), [[0, 0, 1], 0]);
});
