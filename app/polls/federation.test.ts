import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { findRemoteAccountAt } from "../accounts/account_queries.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import { block } from "../graph/blocks.ts";
import { follow } from "../graph/follows.ts";
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
import { insertPoll, pollOf } from "./poll_queries.ts";
import { castVotes, vote } from "./polls.ts";

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
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === type);

Deno.test("Verso says it supports polls", () => {
    assertEquals(registry.extensions.includes("pub.versia:polls"), true);
});

Deno.test("a vote in a remote poll is sent to its instance, a Vote for each option", async () => {
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
    await vote(test.ctx, "alice", poll?.id ?? "", [0]);
    // A vote in a local poll is counted here.
    await vote(test.ctx, "alice", (await ask(test.ctx, "bob")).poll.id, [1]);

    const votes = await test.ctx.db.selectFrom("poll_votes").select(["id", "choice"])
        .where("poll_id", "=", poll?.id ?? "")
        .orderBy("id")
        .execute();
    assertEquals(
        await sent(test.ctx, "pub.versia:polls/Vote"),
        votes.map((row) => ["b.example", {
            type: "pub.versia:polls/Vote",
            id: row.id,
            created_at: test.clock.now().toISOString(),
            author: "alice",
            poll: "b.example:q1",
            option: row.choice,
        }]),
    );
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
    const notes = () => sent(test.ctx, "Note");
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
        (again?.extensions as Record<string, { votes: number[] }>)["pub.versia:polls"].votes,
        [0, 1],
    );
});

/** bob's Vote, on b.test, for `option` of the poll on the status `poll`. */
const voteFor = (id: string, poll: string, option: number) => ({
    type: "pub.versia:polls/Vote",
    id,
    created_at: "2026-01-01T00:00:00Z",
    author: "bob",
    poll,
    option,
});

/** a.test, with alice and her poll, and b.test, which sends whatever it is told to, with bob. */
const open = async (options: { multiple?: boolean; visibility?: Visibility } = {}) => {
    const network = await createNetwork(["a.test"]);
    const a = network.instances["a.test"].ctx;
    const b = await addEvilInstance(network, "b.test");
    b.serve("/.versia/v0.6/entities/User/bob", {
        type: "User",
        id: "bob",
        created_at: "2026-01-01T00:00:00Z",
        username: "bob",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });
    await createLocalAccount(a, "alice");
    const { note, poll } = await ask(a, "alice", options);

    /** Has b.test send `entity` to a.test, and a.test receive it. */
    const send = async (entity: object) => {
        await b.send("https://a.test/.versia/v0.6/inbox", { body: entity });
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

    return {
        network,
        a,
        note,
        poll,
        send,
        counts,
        errors,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a remote vote in a local poll is counted once, however often it is sent", async () => {
    await using test = await open();

    await test.send(voteFor("v1", `a.test:${test.note.id}`, 1));
    await test.send(voteFor("v1", `a.test:${test.note.id}`, 1));
    await test.send(voteFor("v2", `a.test:${test.note.id}`, 1));

    assertEquals(await test.counts(), [[0, 1], 1]);
    assertEquals(await test.errors(), []);
});

Deno.test("remote votes in a poll of several choices count each option once, and voters once", async () => {
    await using test = await open({ multiple: true });

    for (const option of [0, 1, 0]) {
        await test.send(voteFor(`v${option}`, `a.test:${test.note.id}`, option));
    }

    assertEquals(await test.counts(), [[1, 1], 1]);
});

Deno.test("a remote vote that Mastodon wouldn't allow is given up on", async () => {
    await using test = await open();
    const poll = `a.test:${test.note.id}`;

    await test.send(voteFor("v1", poll, 1));
    await test.send(voteFor("v2", poll, 0));
    await test.send(voteFor("v3", poll, 2));
    test.network.clock.advance(3600_000);
    await test.send(voteFor("v4", poll, 0));

    assertEquals(await test.counts(), [[0, 1], 1]);
    const errors = await test.errors();
    assertEquals(errors.length, 3);
    assertStringIncludes(errors[0], "You have already voted on this poll");
    assertStringIncludes(errors[1], "The chosen vote option does not exist");
    assertStringIncludes(errors[2], "The poll has already ended");
});

Deno.test("a remote vote by someone who may not see the poll, or is blocked, is given up on", async () => {
    await using test = await open({ visibility: "private" });
    await test.send(voteFor("v1", `a.test:${test.note.id}`, 1));

    const { note } = await ask(test.a, "alice");
    const bob = await test.a.db.selectFrom("accounts").select("id").where("username", "=", "bob")
        .executeTakeFirstOrThrow();
    await block(test.a, "alice", bob.id);
    await test.send(voteFor("v2", `a.test:${note.id}`, 1));

    assertEquals(await test.counts(), [[0, 0], 0]);
    assertEquals((await pollOf(test.a, note.id))?.voters_count, 0);
    const errors = await test.errors();
    assertEquals(errors.length, 2);
    assertStringIncludes(errors[0], "may not see");
    assertStringIncludes(errors[1], "may not vote");
});

Deno.test("a remote vote in a poll that isn't local, or a status without one, is dropped", async () => {
    await using test = await open();

    await test.send(voteFor("v1", "q1", 0));
    const plain = await createNote(test.a, "alice");
    await test.send(voteFor("v2", `a.test:${plain.id}`, 0));

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
    await test.send(voteFor("v3", "q1", 0));

    assertEquals(await test.errors(), []);
    assertEquals(await test.a.db.selectFrom("poll_votes").selectAll().execute(), []);
});
