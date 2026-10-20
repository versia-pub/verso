import { assertEquals } from "@std/assert";
import { updateProfile } from "../accounts/profile.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { createTestContext, type TestContextOptions } from "../testing/context.ts";
import { followsFrom, followsOf } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";

const open = async (options: TestContextOptions = {}) => {
    const test = await createTestContext(options);
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    return test;
};

/** Each account's following and followers counts. */
const counts = async (ctx: Context) =>
    Object.fromEntries(
        (await ctx.db.selectFrom("accounts")
            .select(["id", "following_count", "followers_count"])
            .orderBy("id")
            .execute())
            .map((row) => [row.id, [row.following_count, row.followers_count]]),
    );

const lock = async (ctx: Context, id: string) => {
    await ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", id).execute();
};

Deno.test("an unlocked local account is followed at once, and counted", async () => {
    await using test = await open();

    assertEquals(await follow(test.ctx, "alice", "bob"), "following");
    assertEquals(await counts(test.ctx), { alice: [1, 0], bob: [0, 1], carol: [0, 0] });
});

Deno.test("a locked account, or one on another instance, is asked, and not counted", async () => {
    await using test = await open();
    await lock(test.ctx, "bob");

    assertEquals(await follow(test.ctx, "alice", "bob"), "requested");
    assertEquals(await follow(test.ctx, "alice", "carol"), "requested");
    assertEquals(await counts(test.ctx), { alice: [0, 0], bob: [0, 0], carol: [0, 0] });
    assertEquals(
        (await followsFrom(test.ctx, "alice", ["bob", "carol"])).map((row) => row.accepted),
        [false, false],
    );
});

Deno.test("following again only changes the options given, and counts once", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob", { showReblogs: false, languages: ["en"] });

    assertEquals(await follow(test.ctx, "alice", "bob", { notify: true }), "following");
    const [row] = await followsFrom(test.ctx, "alice", ["bob"]);
    assertEquals([row?.show_reblogs, row?.notify, row?.languages], [false, true, ["en"]]);

    await follow(test.ctx, "alice", "bob", { languages: null });
    const [all] = await followsFrom(test.ctx, "alice", ["bob"]);
    assertEquals(all?.languages, null);

    assertEquals(await counts(test.ctx), { alice: [1, 0], bob: [0, 1], carol: [0, 0] });
});

Deno.test("asking again stays a request", async () => {
    await using test = await open();
    await lock(test.ctx, "bob");
    await follow(test.ctx, "alice", "bob");

    assertEquals(await follow(test.ctx, "alice", "bob", { notify: true }), "requested");
});

Deno.test("follows made at once count once", async () => {
    await using test = await open();

    const results = await Promise.all([1, 2, 3].map(() => follow(test.ctx, "alice", "bob")));
    assertEquals(results, ["following", "following", "following"]);
    assertEquals(await counts(test.ctx), { alice: [1, 0], bob: [0, 1], carol: [0, 0] });
});

Deno.test("unfollowing uncounts once, and withdrawing a request changes no counts", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "alice", "carol");
    await follow(test.ctx, "bob", "alice");

    assertEquals(await unfollow(test.ctx, "alice", "bob"), true);
    assertEquals(await unfollow(test.ctx, "alice", "bob"), false);
    assertEquals(await unfollow(test.ctx, "alice", "carol"), true);
    assertEquals(await counts(test.ctx), { alice: [0, 1], bob: [1, 0], carol: [0, 0] });
    assertEquals(await followsFrom(test.ctx, "alice", ["bob", "carol"]), []);
});

Deno.test("no one follows themselves, an account that isn't there, or a blocked one", async () => {
    await using test = await open();
    await blockDomain(test.ctx, "b.example");

    assertEquals(await follow(test.ctx, "alice", "alice"), "missing");
    assertEquals(await follow(test.ctx, "alice", "dave"), "missing");
    assertEquals(await follow(test.ctx, "alice", "carol"), "blocked");
    assertEquals(await followsFrom(test.ctx, "alice", ["alice", "carol"]), []);
    assertEquals(await counts(test.ctx), { alice: [0, 0], bob: [0, 0], carol: [0, 0] });
});

Deno.test("follows are found from or of one account, among only the others asked about", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "alice", "carol");
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "bob");

    const followees = async (ids: string[]) =>
        (await followsFrom(test.ctx, "alice", ids)).map((row) => row.followee_id).toSorted();
    const followers = async (ids: string[]) =>
        (await followsOf(test.ctx, "bob", ids)).map((row) => row.follower_id).toSorted();

    assertEquals(await followees(["carol"]), ["carol"]);
    assertEquals(await followees(["bob", "carol", "dave"]), ["bob", "carol"]);
    assertEquals(await followees([]), []);
    assertEquals(await followers(["carol"]), ["carol"]);
    assertEquals(await followers(["alice", "carol"]), ["alice", "carol"]);
    assertEquals(await followers([]), []);
});

Deno.test("accepting a request follows and counts, once, and only a request", async () => {
    await using test = await open();
    await lock(test.ctx, "bob");
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "carol", "alice");

    assertEquals(await acceptFollow(test.ctx, "alice", "bob"), true);
    assertEquals(await acceptFollow(test.ctx, "alice", "bob"), false);
    assertEquals(await acceptFollow(test.ctx, "carol", "alice"), false);
    assertEquals(await acceptFollow(test.ctx, "bob", "alice"), false);
    assertEquals(await counts(test.ctx), { alice: [1, 1], bob: [0, 1], carol: [1, 0] });
    assertEquals(await followsFrom(test.ctx, "bob", ["alice"]), []);
});

Deno.test("rejecting removes a request, or a follower, who is then uncounted", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "bob");
    await follow(test.ctx, "alice", "carol");

    assertEquals(await rejectFollow(test.ctx, "alice", "bob"), true);
    assertEquals(await rejectFollow(test.ctx, "alice", "carol"), true);
    assertEquals(await rejectFollow(test.ctx, "alice", "carol"), false);
    assertEquals(await counts(test.ctx), { alice: [0, 0], bob: [0, 0], carol: [0, 0] });
    assertEquals(await followsFrom(test.ctx, "alice", ["bob", "carol"]), []);
});

Deno.test("each change to a follow is told, and nothing else is", async () => {
    const events: unknown[] = [];
    await using test = await open({
        subscribers: [(_, event) => Promise.resolve(void events.push(event))],
    });
    await lock(test.ctx, "bob");

    await follow(test.ctx, "alice", "carol");
    await follow(test.ctx, "alice", "carol", { notify: true });
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "alice", "bob");
    await acceptFollow(test.ctx, "alice", "bob");
    await acceptFollow(test.ctx, "alice", "bob");
    await rejectFollow(test.ctx, "alice", "bob");
    await unfollow(test.ctx, "alice", "carol");
    await unfollow(test.ctx, "alice", "carol");
    await rejectFollow(test.ctx, "alice", "carol");
    await follow(test.ctx, "alice", "alice");

    assertEquals(events, [
        { type: "graph.follow_requested", followerId: "alice", followeeId: "carol" },
        { type: "graph.follow_accepted", followerId: "carol", followeeId: "alice" },
        { type: "graph.follow_requested", followerId: "alice", followeeId: "bob" },
        { type: "graph.follow_accepted", followerId: "alice", followeeId: "bob" },
        { type: "graph.follow_rejected", followerId: "alice", followeeId: "bob" },
        { type: "graph.unfollowed", followerId: "alice", followeeId: "carol" },
    ]);
});

Deno.test("unlocking an account accepts everyone asking to follow it", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "dave");
    await lock(test.ctx, "alice");
    await lock(test.ctx, "bob");
    await follow(test.ctx, "bob", "alice");
    await follow(test.ctx, "carol", "alice");
    await follow(test.ctx, "dave", "bob");

    await updateProfile(test.ctx, "alice", { locked: false });

    assertEquals(
        (await followsOf(test.ctx, "alice", ["bob", "carol"])).map((row) => row.accepted),
        [true, true],
    );
    assertEquals((await followsOf(test.ctx, "bob", ["dave"]))[0]?.accepted, false);
    assertEquals(await counts(test.ctx), {
        alice: [0, 2],
        bob: [1, 0],
        carol: [1, 0],
        dave: [0, 0],
    });
});
