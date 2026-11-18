import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { findRemoteAccountAt } from "../accounts/account_queries.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { queuedDeliveries } from "../federation/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow } from "../graph/follows.ts";
import { undo } from "../interactions/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import type { Visibility } from "../kernel/visibility.ts";
import { postNote } from "../notes/notes.ts";
import { createNote } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { endPolls } from "./ending.ts";
import { voteType } from "./federation.ts";
import { insertPoll, insertRemoteBallot, pollOf } from "./poll_queries.ts";
import { castVotes, vote } from "./polls.ts";
import { pollUpdatesQueue } from "./updating.ts";

/** Has `accountId` ask "Which?", in a poll of an hour, and returns the status and its poll. */
const ask = async (
    ctx: Context,
    accountId: string,
    { multiple = false, visibility = "public" }: { multiple?: boolean; visibility?: Visibility } =
        {},
) => {
    const note = await postNote(ctx, accountId, {
        text: "Which?",
        format: "text/plain",
        spoilerText: "",
        visibility,
        poll: { options: ["Red", "Blue"], expiresIn: 3600, multiple, hideTotals: false },
    });
    assertExists(note);
    const poll = await pollOf(ctx, note.id);
    assertExists(poll);

    return { note, poll };
};

/** The entities of `type` queued to be sent, with the instance each is for. */
const sent = async (ctx: Context, type: string) =>
    (await queuedDeliveries(ctx))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === type);

Deno.test("Verso says it supports polls", () => {
    assertEquals(registry.extensions.includes("pub.versia:polls"), true);
});

Deno.test("a voter's ballot in a remote poll is sent to its instance as one Vote, again with more choices", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    for (const [id, domain] of [["carol", "b.example"], ["erin", "c.example"]]) {
        await createRemoteAccount(test.ctx, id, await createInstance(test.ctx, domain));
    }
    // erin's instance follows alice, but isn't told of her votes.
    await follow(test.ctx, "erin", "alice");
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "q1" });
    await insertPoll(test.ctx, note.id, {
        options: ["Red", "Blue", "Green"],
        multiple: true,
        hideTotals: false,
        expiresAt: null,
    });
    const poll = await pollOf(test.ctx, note.id);

    await vote(test.ctx, "alice", poll?.id ?? "", [2]);
    const voted = test.clock.now().toISOString();
    test.clock.advance(1000);
    await vote(test.ctx, "alice", poll?.id ?? "", [0]);
    // A vote in a local poll is counted here.
    await vote(test.ctx, "alice", (await ask(test.ctx, "bob")).poll.id, [1]);

    const ballot = await test.ctx.db.selectFrom("poll_ballots").select("id")
        .where("poll_id", "=", poll?.id ?? "")
        .executeTakeFirstOrThrow();
    const entity = {
        type: "pub.versia:polls/Vote",
        id: ballot.id,
        created_at: voted,
        author: "social.example:alice",
        target: "b.example:q1",
    };
    assertEquals(await sent(test.ctx, "pub.versia:polls/Vote"), [
        ["b.example", { ...entity, options: [2] }],
        ["b.example", { ...entity, updated_at: test.clock.now().toISOString(), options: [0, 2] }],
    ]);
});

Deno.test("a local poll that ends is sent again, to its audience and those who voted", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    for (const [id, domain] of [["erin", "c.example"], ["frank", "d.example"]]) {
        await createRemoteAccount(test.ctx, id, await createInstance(test.ctx, domain));
    }
    await follow(test.ctx, "erin", "alice");
    const { note, poll } = await ask(test.ctx, "alice");
    await test.ctx.transaction((tx) => castVotes(tx, "frank", poll.id, [1]));
    // gina voted in another poll, which hasn't ended.
    await createRemoteAccount(test.ctx, "gina", await createInstance(test.ctx, "g.example"));
    const later = await postNote(test.ctx, "alice", {
        text: "And?",
        format: "text/plain",
        spoilerText: "",
        poll: { options: ["Yes", "No"], expiresIn: 7200, multiple: false, hideTotals: false },
    });
    const laterPoll = await pollOf(test.ctx, later?.id ?? "");
    await test.ctx.transaction((tx) => castVotes(tx, "gina", laterPoll?.id ?? "", [0]));
    // A remote poll that ends is its instance's to send, even to those its status mentions.
    const remote = await createNote(
        test.ctx,
        "frank",
        { instance_id: "d.example", remote_id: "q1" },
        ["gina"],
    );
    await insertPoll(test.ctx, remote.id, {
        options: ["Yes", "No"],
        multiple: false,
        hideTotals: false,
        expiresAt: test.clock.now(),
    });

    const notes = () => sent(test.ctx, "pub.versia:social/Note");
    assertEquals((await notes()).map(([domain]) => domain), ["c.example", "c.example"]);

    test.clock.advance(3600_000);
    await endPolls(test.ctx);

    const [[, again]] = (await notes()).filter(([domain]) => domain === "d.example");
    assertEquals((await notes()).map(([domain]) => domain), [
        "c.example",
        "c.example",
        "c.example",
        "d.example",
    ]);
    assertEquals(again?.id, note.id);
    assertEquals(
        (again?.extensions as Record<string, { options: { votes: number }[] }>)["pub.versia:polls"]
            .options.map((option) => option.votes),
        [0, 1],
    );
});

/** bob's Vote, on b.test, for the options `options` of the poll on the status `target`. */
const voteFor = (
    id: string,
    target: string,
    options: number[],
    more: { updated_at?: string; author?: string } = {},
) => ({
    type: "pub.versia:polls/Vote",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "b.test:bob",
    target,
    options,
    ...more,
});

/** a.test, with alice and her poll, and b.test, which sends whatever it is told to, with bob. */
const open = async (options: { multiple?: boolean; visibility?: Visibility } = {}) => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.7/entities/User/bob", {
        type: "User",
        id: "bob",
        created_at: "2026-01-01T00:00:00Z",
        username: "bob",
        manually_approves_subscribers: false,
        indexable: true,
    });
    await createLocalAccount(a, "alice");
    const { note, poll } = await ask(a, "alice", options);

    /** Has b.test send `entity` to a.test, and a.test receive it. */
    const send = async (entity: object) => {
        // So that a Vote sent again isn't mistaken for a replay.
        network.clock.advance(1000);
        await b.send("https://a.test/.versia/v0.7/inbox", { body: entity });
        await network.drain();
    };

    /** The poll's counts, and how many voted. */
    const counts = async () => {
        const now = await pollOf(a, note.id);
        return [now?.options.map((option) => option.votes_count), now?.voters_count];
    };

    /** Why a.test gave up on what it was sent, oldest first. */
    const errors = async () =>
        (await a.db.selectFrom("jobs").select("last_error").where("queue", "=", "inbox")
            .where("last_error", "is not", null).orderBy("created_at").execute())
            .map((job) => job.last_error ?? "");

    /** How many sendings of the poll are queued. */
    const updates = async () =>
        (await a.db.selectFrom("jobs").select("id").where("queue", "=", pollUpdatesQueue)
            .execute()).length;

    return {
        network,
        a,
        b,
        note,
        poll,
        send,
        counts,
        errors,
        updates,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a followers-only poll that ends isn't sent to the voters its author blocks since, but a public one is", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const accounts = [["erin", "c.example"], ["frank", "d.example"], ["gus", "g.example"], [
        "hank",
        "h.example",
    ]];
    for (const [id, domain] of accounts) {
        await createRemoteAccount(test.ctx, id, await createInstance(test.ctx, domain));
    }

    // Gus doesn't follow alice, so votes only in the public poll.
    for (const id of ["erin", "frank", "hank"]) await follow(test.ctx, id, "alice");
    const [followersOnly, open] = [
        await ask(test.ctx, "alice", { visibility: "private" }),
        await ask(test.ctx, "alice"),
    ];
    for (const id of ["frank", "hank"]) {
        await test.ctx.transaction((tx) => castVotes(tx, id, followersOnly.poll.id, [1]));
    }
    await test.ctx.transaction((tx) => castVotes(tx, "gus", open.poll.id, [1]));
    await block(test.ctx, "alice", "frank");
    await block(test.ctx, "alice", "gus");
    await blockDomainFor(test.ctx, "alice", "h.example");
    const before = (await sent(test.ctx, "pub.versia:social/Note")).length;

    test.clock.advance(3600_000);
    await endPolls(test.ctx);

    const again = (await sent(test.ctx, "pub.versia:social/Note")).slice(before)
        .map(([domain, entity]) => [domain, entity.id]);
    assertEquals(
        again.toSorted(),
        [
            ["c.example", followersOnly.note.id],
            ["c.example", open.note.id],
            ["d.example", open.note.id],
            ["g.example", open.note.id],
            ["h.example", open.note.id],
        ].toSorted(),
    );
});

Deno.test("a remote vote in a local poll is counted once, however often it is sent", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;
    // A ballot in another poll doesn't count in this one.
    const other = await ask(test.a, "alice");
    await test.send(voteFor("v2", `a.test:${other.note.id}`, [0]));

    await test.send(voteFor("v1", target, [1]));
    await test.send(voteFor("v1", target, [1]));
    await test.send(voteFor("v1", target, [1], { updated_at: "2026-01-01T00:00:00Z" }));

    assertEquals(await test.counts(), [[0, 1], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("a Vote sent again with other options changes the ballot, unless it is older", async () => {
    await using test = await open({ multiple: true });
    const target = `a.test:${test.note.id}`;

    await test.send(voteFor("v1", target, [0]));
    assertEquals(await test.counts(), [[1, 0], 1]);

    await test.send(voteFor("v1", target, [1], { updated_at: "2026-01-02T00:00:00Z" }));
    assertEquals(await test.counts(), [[0, 1], 1]);

    // Back to the first choice, and then more.
    await test.send(voteFor("v1", target, [1, 0], { updated_at: "2026-01-03T00:00:00Z" }));
    assertEquals(await test.counts(), [[1, 1], 1]);

    await test.send(voteFor("v1", target, [0], { updated_at: "2026-01-02T12:00:00Z" }));
    assertEquals(await test.counts(), [[1, 1], 1]);

    // The same choices, sent again later, still make the ballot newer.
    await test.send(voteFor("v1", target, [0, 1], { updated_at: "2026-01-04T00:00:00Z" }));
    await test.send(voteFor("v1", target, [0], { updated_at: "2026-01-03T12:00:00Z" }));
    assertEquals(await test.counts(), [[1, 1], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("a Vote sent again without `updated_at` changes the ballot, even back to what it was", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;

    await test.send(voteFor("v1", target, [0]));
    await test.send(voteFor("v1", target, [1]));
    await test.send(voteFor("v1", target, [0]));

    assertEquals(await test.counts(), [[1, 0], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("a poll is sent again after a Vote changes it, but not after one that doesn't", async () => {
    await using test = await open({ multiple: true });
    const target = `a.test:${test.note.id}`;
    const settle = async () => {
        test.network.clock.advance(60_000);
        await test.network.drain();
    };

    await test.send(voteFor("v1", target, [0]));
    assertEquals(await test.updates(), 1);
    await settle();
    assertEquals(await test.updates(), 0);

    await test.send(voteFor("v1", target, [0], { updated_at: "2026-01-02T00:00:00Z" }));
    assertEquals(await test.updates(), 0);

    await test.send(voteFor("v1", target, [0, 1], { updated_at: "2026-01-03T00:00:00Z" }));
    assertEquals(await test.updates(), 1);
    await settle();

    // The same choices in another order.
    await test.send(voteFor("v1", target, [1, 0], { updated_at: "2026-01-04T00:00:00Z" }));
    assertEquals(await test.updates(), 0);
});

Deno.test("remote votes in a poll of several choices count each option once, and voters once", async () => {
    await using test = await open({ multiple: true });
    const target = `a.test:${test.note.id}`;

    await test.send(voteFor("v1", target, [1, 0]));

    assertEquals(await test.counts(), [[1, 1], 1]);
    const [ballot] = await test.a.db.selectFrom("poll_ballots").selectAll().execute();
    assertEquals(ballot.remote_id, "v1");
    assertEquals(
        (await test.a.db.selectFrom("poll_votes").select("choice").orderBy("choice").execute())
            .map((row) => row.choice),
        [0, 1],
    );
});

Deno.test("a remote vote that Mastodon wouldn't allow is given up on", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;
    const other = await ask(test.a, "alice");

    await test.send(voteFor("v1", target, [1]));
    // Another ballot, and more, or unknown, options in the one it has.
    await test.send(voteFor("v2", target, [0]));
    await test.send(voteFor("v1", target, [0, 1], { updated_at: "2026-01-02T00:00:00Z" }));
    await test.send(voteFor("v1", target, [2], { updated_at: "2026-01-03T00:00:00Z" }));
    // A first Vote with an unknown option, or in a poll that has ended.
    await test.send(voteFor("v3", `a.test:${other.note.id}`, [2]));
    test.network.clock.advance(3600_000);
    await test.send(voteFor("v4", `a.test:${other.note.id}`, [0]));

    assertEquals(await test.counts(), [[0, 1], 1]);
    const errors = await test.errors();
    assertEquals(errors.length, 5);
    assertStringIncludes(errors[0], "has voted in a.test:");
    assertStringIncludes(errors[1], "You have already voted on this poll");
    assertStringIncludes(errors[2], "The chosen vote option does not exist");
    assertStringIncludes(errors[3], "The chosen vote option does not exist");
    assertStringIncludes(errors[4], "The poll has already ended");
});

Deno.test("a Vote in place of a migrated ballot, which has no Vote id, is given up on", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;
    await test.send(voteFor("v1", target, [1]));
    await test.a.db.updateTable("poll_ballots").set({ remote_id: null }).execute();

    await test.send(voteFor("v1", target, [0], { updated_at: "2026-01-02T00:00:00Z" }));

    assertEquals(await test.counts(), [[0, 1], 1]);
    assertStringIncludes((await test.errors())[0], "has voted in a.test:");
});

Deno.test("a Vote for another poll than its id first named is dropped", async () => {
    await using test = await open();
    const other = await ask(test.a, "alice");

    await test.send(voteFor("v1", `a.test:${test.note.id}`, [1]));
    await test.send(voteFor("v1", `a.test:${other.note.id}`, [0]));

    assertEquals(await test.counts(), [[0, 1], 1]);
    assertEquals((await pollOf(test.a, other.note.id))?.voters_count, 0);
    assertEquals(await test.errors(), []);
});

Deno.test("a poll that has ended keeps the ballots it has, however they are sent after", async () => {
    await using test = await open({ multiple: true });
    const target = `a.test:${test.note.id}`;
    await test.send(voteFor("v1", target, [0]));
    test.network.clock.advance(3600_000);
    await endPolls(test.a);

    await test.send(voteFor("v1", target, [1], { updated_at: "2026-01-02T00:00:00Z" }));
    await test.send(undo("pub.versia:polls/Vote", "v1"));

    assertEquals(await test.counts(), [[1, 0], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("a Delete withdraws a Vote, which the voter may replace with another", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;
    await test.send(voteFor("v1", target, [1]));
    test.network.clock.advance(60_000);
    await test.network.drain();
    assertEquals(await test.updates(), 0);

    await test.send(undo("pub.versia:polls/Vote", "v1"));

    assertEquals(await test.counts(), [[0, 0], 0]);
    assertEquals(await test.a.db.selectFrom("poll_ballots").select("id").execute(), []);
    assertEquals(await test.updates(), 1);

    await test.send(voteFor("v2", target, [0]));
    assertEquals(await test.counts(), [[1, 0], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("only the instance of a voter can say that a Vote is theirs", async () => {
    await using test = await open();
    await test.send(voteFor("v1", `a.test:${test.note.id}`, [1]));
    const instance = async (domain: string) =>
        (await test.a.db.selectFrom("instances").select("id").where("domain", "=", domain)
            .executeTakeFirstOrThrow()).id;
    const from = async (domain: string) => ({
        domain,
        instanceId: await instance(domain),
        fetched: false,
    });
    await createInstance(test.a, "c.test");

    assertEquals(await voteType.hasRemote?.(test.a, "v1", await from("b.test")), true);
    assertEquals(await voteType.hasRemote?.(test.a, "v1", await from("c.test")), false);
    assertEquals(await voteType.hasRemote?.(test.a, "v2", await from("b.test")), false);

    await voteType.deleteRemote?.(test.a, "v1", await from("c.test"));
    assertEquals(await test.counts(), [[0, 1], 1]);
});

Deno.test("a Vote with a bare author or target is refused at the inbox", async () => {
    await using test = await open();
    const target = `a.test:${test.note.id}`;

    for (
        const body of [
            voteFor("v1", test.note.id, [1]),
            voteFor("v1", target, [1], { author: "bob" }),
        ]
    ) {
        assertEquals(
            (await test.b.send("https://a.test/.versia/v0.7/inbox", { body })).status,
            422,
        );
    }

    assertEquals(await test.counts(), [[0, 0], 0]);
});

Deno.test("a remote vote by someone who may not see the poll is given up on, and one by someone blocked counts", async () => {
    await using test = await open({ visibility: "private" });
    await test.send(voteFor("v1", `a.test:${test.note.id}`, [1]));

    const { note } = await ask(test.a, "alice");
    const bob = await test.a.db.selectFrom("accounts").select("id").where("username", "=", "bob")
        .executeTakeFirstOrThrow();
    await block(test.a, "alice", bob.id);
    await test.send(voteFor("v2", `a.test:${note.id}`, [1]));

    assertEquals(await test.counts(), [[0, 0], 0]);
    assertEquals((await pollOf(test.a, note.id))?.options.map((option) => option.votes_count), [
        0,
        1,
    ]);
    const errors = await test.errors();
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0], "may not see");
});

Deno.test("a remote vote in a poll that isn't local, or a status without one, is dropped", async () => {
    await using test = await open();

    await test.send(voteFor("v1", "b.test:q1", [0]));
    const plain = await createNote(test.a, "alice");
    await test.send(voteFor("v2", `a.test:${plain.id}`, [0]));

    // Nothing was fetched for them.
    assertEquals(await findRemoteAccountAt(test.a, "b.test", "bob"), undefined);

    await test.a.federation.resolve(test.a, { host: "b.test", id: "bob" }, "User");
    const bob = await test.a.db.selectFrom("accounts").select(["id", "instance_id"])
        .where("username", "=", "bob")
        .executeTakeFirstOrThrow();
    const remote = await createNote(test.a, bob.id, {
        instance_id: bob.instance_id,
        remote_id: "q1",
    });
    await insertPoll(test.a, remote.id, {
        options: ["Yes", "No"],
        multiple: false,
        hideTotals: false,
        expiresAt: null,
    });
    await test.send(voteFor("v3", "b.test:q1", [0]));

    assertEquals(await test.errors(), []);
    assertEquals(await test.a.db.selectFrom("poll_votes").selectAll().execute(), []);
});

Deno.test("a local voter's ballot in a remote poll may be fetched by the poll author's instance only", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    for (const [id, domain] of [["carol", "b.example"], ["erin", "c.example"]]) {
        await createRemoteAccount(test.ctx, id, await createInstance(test.ctx, domain));
    }
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "q1" });
    await insertPoll(test.ctx, note.id, {
        options: ["Red", "Blue", "Green"],
        multiple: true,
        hideTotals: false,
        expiresAt: null,
    });
    const poll = await pollOf(test.ctx, note.id);
    await vote(test.ctx, "alice", poll?.id ?? "", [2, 0]);
    const ballot = await test.ctx.db.selectFrom("poll_ballots").selectAll()
        .executeTakeFirstOrThrow();

    const found = await voteType.find?.(test.ctx, ballot.id, "b.example");

    assertEquals(found, {
        type: "pub.versia:polls/Vote",
        id: ballot.id,
        created_at: test.clock.now().toISOString(),
        author: "social.example:alice",
        target: "b.example:q1",
        options: [0, 2],
    });
    assertEquals(await voteType.find?.(test.ctx, ballot.id, "c.example"), undefined);
    assertEquals(await voteType.find?.(test.ctx, "missing", "b.example"), undefined);

    // A remote voter's ballot is their instance's to send.
    await insertRemoteBallot(test.ctx, {
        id: "erins",
        poll_id: poll?.id ?? "",
        account_id: "erin",
        remote_id: null,
        created_at: test.clock.now(),
        updated_at: null,
    }, [1]);
    assertEquals(await voteType.find?.(test.ctx, "erins", "b.example"), undefined);

    // A vote in a local poll is no one else's to fetch.
    const local = await ask(test.ctx, "bob");
    await vote(test.ctx, "alice", local.poll.id, [1]);
    const mine = await test.ctx.db.selectFrom("poll_ballots").select("id")
        .where("poll_id", "=", local.poll.id).executeTakeFirstOrThrow();
    assertEquals(await voteType.find?.(test.ctx, mine.id, "b.example"), undefined);
});
