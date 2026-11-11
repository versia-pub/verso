import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { insertFollow } from "../graph/follow_queries.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { silence, unsilence } from "../moderation/silences.ts";
import { suspend, unsuspend } from "../moderation/suspensions.ts";
import { createTestContext } from "../testing/context.ts";
import { friendsOfFriends } from "./suggestion_queries.ts";
import { dismissSuggestion, suggestionsFor } from "./suggestions.ts";

const page = { offset: 0, limit: 40 };

/**
 * Alice, who follows ann and bea, and the discoverable accounts cat, dan and eve. Ann follows cat
 * and dan, and bea follows cat, so cat is followed by more of Alice's follows than dan. Eve has
 * no followers.
 */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "ann", "bea", "cat", "dan", "eve"]) {
        await createLocalAccount(test.ctx, id);
    }
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();

    const follow = async (follower: string, followee: string, accepted = true) => {
        await insertFollow(test.ctx, {
            followerId: follower,
            followeeId: followee,
            accepted,
            options: {},
        });
    };
    await follow("alice", "ann");
    await follow("alice", "bea");
    await follow("ann", "cat");
    await follow("ann", "dan");
    await follow("bea", "cat");

    /** Who is suggested to Alice, with why, in order. */
    const suggested = async (featured: string[] = [], viewer = "alice") =>
        (await suggestionsFor(test.ctx, viewer, featured, page))
            .map(({ accountId, sources }) => `${accountId}: ${sources.join(" ")}`);

    return { ...test, follow, suggested };
};

Deno.test("the friends of friends are suggested, the most followed by friends first", async () => {
    await using test = await open();

    assertEquals(await test.suggested(), [
        "cat: friends_of_friends",
        "dan: friends_of_friends",
    ]);
});

Deno.test("friends of friends with the same count come with the fewest followers first", async () => {
    await using test = await open();
    await test.follow("bea", "dan");
    await test.ctx.db.updateTable("accounts").set({ followers_count: 9 })
        .where("id", "=", "cat").execute();
    await test.ctx.db.updateTable("accounts").set({ followers_count: 2 })
        .where("id", "=", "dan").execute();

    assertEquals(await test.suggested(), [
        "dan: friends_of_friends",
        "cat: friends_of_friends",
    ]);
});

Deno.test("friends who hide their follows, and follows not yet accepted, don't count", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ hide_collections: true })
        .where("id", "=", "bea").execute();
    await test.follow("ann", "eve", false);
    await test.follow("alice", "eve", false);

    assertEquals(await test.suggested(), [
        "cat: friends_of_friends",
        "dan: friends_of_friends",
    ]);

    await test.ctx.db.updateTable("accounts").set({ hide_collections: true })
        .where("id", "=", "ann").execute();
    assertEquals(await test.suggested(), []);
});

Deno.test("accounts that the user follows, requested, blocks, mutes, or that block them aren't suggested", async () => {
    await using test = await open();
    await test.follow("ann", "alice");
    await test.follow("ann", "eve");
    await test.follow("alice", "cat", false);
    assertEquals(await test.suggested(), ["dan: friends_of_friends", "eve: friends_of_friends"]);

    await mute(test.ctx, "alice", "dan", { notifications: false, duration: 0 });
    assertEquals(await test.suggested(), ["eve: friends_of_friends"]);

    await block(test.ctx, "eve", "alice");
    assertEquals(await test.suggested(), []);
});

Deno.test("accounts on a domain the user blocks aren't suggested, and remote ones count as discoverable", async () => {
    await using test = await open();
    const instanceId = await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "remote", instanceId);
    await test.follow("ann", "remote");
    await test.ctx.db.updateTable("accounts").set({ discoverable: false })
        .where("id", "in", ["cat", "dan"]).execute();
    assertEquals(await test.suggested(), ["remote: friends_of_friends"]);

    await blockDomainFor(test.ctx, "alice", "b.example");
    assertEquals(await test.suggested(), []);
});

Deno.test("a dismissed account isn't suggested again, only to the user who dismissed it", async () => {
    await using test = await open();
    await dismissSuggestion(test.ctx, "alice", "cat");
    await dismissSuggestion(test.ctx, "alice", "cat");
    await dismissSuggestion(test.ctx, "alice", "missing");

    assertEquals(await test.suggested(), ["dan: friends_of_friends"]);
    assertEquals(
        await test.ctx.db.selectFrom("suggestion_dismissals").select("target_id").execute(),
        [{ target_id: "cat" }],
    );

    await test.follow("eve", "ann");
    await test.follow("eve", "bea");
    assertEquals(await test.suggested([], "eve"), [
        "cat: friends_of_friends",
        "dan: friends_of_friends",
    ]);
});

Deno.test("the accounts an admin picked come first, with both sources if friends follow them", async () => {
    await using test = await open();
    const instanceId = await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "remote", instanceId);

    assertEquals(
        await test.suggested([
            "eve",
            "@dan",
            "remote@b.example",
            "missing",
            "ann",
            "alice",
            "x@@y",
        ]),
        [
            "eve: featured",
            "dan: featured friends_of_friends",
            "remote: featured",
            "cat: friends_of_friends",
        ],
    );
});

Deno.test("an admin's picks that the user can't be suggested aren't", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ discoverable: false })
        .where("id", "=", "eve").execute();
    await dismissSuggestion(test.ctx, "alice", "dan");

    assertEquals(await test.suggested(["eve", "dan", "unknown@nowhere.example"]), [
        "cat: friends_of_friends",
    ]);
});

Deno.test("suggestions are paged by offset", async () => {
    await using test = await open();
    const ask = async (offset: number, limit: number) =>
        (await suggestionsFor(test.ctx, "alice", ["eve"], { offset, limit }))
            .map((one) => one.accountId);

    assertEquals(await ask(0, 2), ["eve", "cat"]);
    assertEquals(await ask(2, 2), ["dan"]);
    assertEquals(await ask(3, 2), []);
});

Deno.test("a request to follow doesn't make a friend, nor a friend's request a follow", async () => {
    await using test = await open();
    for (const id of ["fay", "gus", "hal"]) await createLocalAccount(test.ctx, id);
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    await test.follow("alice", "fay", false);
    await test.follow("fay", "gus");
    await test.follow("ann", "hal", false);

    assertEquals(await test.suggested(), [
        "cat: friends_of_friends",
        "dan: friends_of_friends",
    ]);
});

Deno.test("each source gives at most 40 accounts, and the query only as many as it is asked for", async () => {
    await using test = await open();
    for (let i = 0; i < 45; i++) {
        const id = `n${String(i).padStart(2, "0")}`;
        await createLocalAccount(test.ctx, id);
        await test.ctx.db.updateTable("accounts").set({ discoverable: true })
            .where("id", "=", id).execute();
        await test.follow("ann", id);
    }

    assertEquals(
        (await suggestionsFor(test.ctx, "alice", [], { offset: 0, limit: 80 })).length,
        40,
    );
    assertEquals((await friendsOfFriends(test.ctx, "alice", 2)).length, 2);
});

Deno.test("the picks that Verso doesn't know are not looked up on their instances", async () => {
    await using test = await open();

    assertEquals(await test.suggested(["ghost@remote.example"]), [
        "cat: friends_of_friends",
        "dan: friends_of_friends",
    ]);
    assertEquals(test.transport.sent.length, 0);
});

Deno.test("suspended and silenced accounts aren't suggested, from either source", async () => {
    await using test = await open();
    await suspend(test.ctx, "cat");
    await silence(test.ctx, "dan");

    assertEquals(await test.suggested(["cat", "dan", "eve"]), ["eve: featured"]);

    await unsuspend(test.ctx, "cat");
    await unsilence(test.ctx, "dan");
    assertEquals(await test.suggested(), ["cat: friends_of_friends", "dan: friends_of_friends"]);
});

Deno.test("accounts that moved aren't suggested, from either source", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts")
        .set({ moved_to_account_id: "eve" })
        .where("id", "in", ["cat", "dan"])
        .execute();

    assertEquals(await test.suggested(["cat", "dan", "eve"]), ["eve: featured"]);
});
