import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { refreshTrendingStatuses, refreshTrendingTags } from "./refresh.ts";

const hour = 60 * 60 * 1000;

/** The clock at noon on a day, with a local user, and a remote one. */
const open = async () => {
    const test = await createTestContext();
    test.clock.advance(Date.parse("2026-01-08T12:00:00Z") - test.clock.now().getTime());
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "remote.example");
    await createRemoteAccount(test.ctx, "rem", "remote.example");

    return test;
};

/** Who used a hashtag today, each in a public status. */
const use = async (
    test: Awaited<ReturnType<typeof open>>,
    tag: string,
    accounts: string[],
    at = "2026-01-08T09:00:00Z",
) => {
    for (const account of accounts) {
        await createNote(test.ctx, account, { created_at: new Date(at) }, [], [tag]);
    }
};

const tagNames = async (test: Awaited<ReturnType<typeof open>>) =>
    (await test.ctx.db.selectFrom("trending_tags").selectAll().orderBy("name").execute())
        .map((row) => [row.name, row.score]);

Deno.test("a hashtag trends when enough accounts used it today, more than yesterday", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);

    await use(test, "cats", accounts);
    await use(test, "dogs", accounts.slice(0, 4));
    // One used it yesterday, as expected, and five today: (5 - 1)² / 1.
    await use(test, "cats", ["alice"], "2026-01-07T09:00:00Z");
    // As many yesterday as today.
    await use(test, "owls", accounts);
    await use(test, "owls", accounts, "2026-01-07T09:00:00Z");

    await refreshTrendingTags(test.ctx);
    assertEquals(await tagNames(test), [["cats", 16]]);
});

Deno.test("only public statuses count toward a hashtag trending", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);

    for (const account of accounts) {
        await createNote(
            test.ctx,
            account,
            { visibility: account === "e" ? "unlisted" : "public" },
            [],
            ["cats"],
        );
    }

    await refreshTrendingTags(test.ctx);
    assertEquals(await tagNames(test), []);
});

Deno.test("a hashtag stays while its peak decays, and leaves when it is too low", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);
    await use(test, "cats", accounts);

    await refreshTrendingTags(test.ctx);
    test.clock.advance(4 * hour);
    await refreshTrendingTags(test.ctx);
    // The peak is from the first refresh, and has halved.
    assertEquals(await tagNames(test), [["cats", 8]]);
    const [row] = await test.ctx.db.selectFrom("trending_tags").selectAll().execute();
    assertEquals(row.max_score, 16);
    assertEquals(row.max_score_at, new Date("2026-01-08T12:00:00Z"));

    // After 16 hours more it's below 1; the day has changed, so nobody used it today.
    test.clock.advance(16 * hour);
    await refreshTrendingTags(test.ctx);
    assertEquals(await tagNames(test), []);
});

Deno.test("a hashtag's old peak is forgotten after two days", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);
    await use(test, "cats", accounts);
    await refreshTrendingTags(test.ctx);

    test.clock.advance(3 * 24 * hour);
    await refreshTrendingTags(test.ctx);
    assertEquals(await tagNames(test), []);
});

/** The ids of the trending statuses, the highest scoring first, with their scores. */
const trendingStatuses = async (test: Awaited<ReturnType<typeof open>>) =>
    (await test.ctx.db.selectFrom("trending_statuses").selectAll().orderBy("score", "desc")
        .execute()).map((row) => [row.note_id, row.score]);

Deno.test("a status trends by its likes and boosts, decayed by its age, one for each author", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    const posted = (account: string, interactions: number, hoursAgo: number) =>
        createNote(test.ctx, account, {
            likes_count: interactions - 2,
            shares_count: 2,
            created_at: new Date(test.clock.now().getTime() - hoursAgo * hour),
        });

    const best = await posted("alice", 11, 0);
    await posted("alice", 11, 1);
    const remote = await posted("rem", 5, 1);
    await posted("alice", 4, 0);

    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), [[best.id, 100], [remote.id, 8]]);
});

Deno.test("a status that has decayed too much stops trending", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    await createNote(test.ctx, "alice", { likes_count: 5 });

    await refreshTrendingStatuses(test.ctx);
    assertEquals((await trendingStatuses(test)).length, 1);

    // 16 / 2⁶ = 0.25, below 0.3.
    test.clock.advance(6 * hour);
    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), []);
});

Deno.test("only public statuses that aren't boosts, replies, sensitive or warned about trend", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    for (const id of ["b", "c", "d", "e", "f", "g"]) {
        await createLocalAccount(test.ctx, id);
        await test.ctx.db.updateTable("accounts").set({ discoverable: true })
            .where("id", "=", id).execute();
    }

    const liked = { likes_count: 5 };
    const parent = await createNote(test.ctx, "alice");
    await createNote(test.ctx, "b", { ...liked, visibility: "unlisted" });
    await createNote(test.ctx, "c", { ...liked, sensitive: true });
    await createNote(test.ctx, "d", { ...liked, spoiler_text: "Careful" });
    await createNote(test.ctx, "e", {
        ...liked,
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "alice",
    });
    await createNote(test.ctx, "f", { ...liked, reblog_of_id: parent.id });
    const fine = await createNote(test.ctx, "g", liked);

    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), [[fine.id, 16]]);
});

Deno.test("a local author must be discoverable, but a remote one needn't be", async () => {
    await using test = await open();
    await createNote(test.ctx, "alice", { likes_count: 5 });
    const remote = await createNote(test.ctx, "rem", { likes_count: 5 });

    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), [[remote.id, 16]]);
});

Deno.test("a status dated in the future doesn't trend more for it", async () => {
    await using test = await open();
    const remote = await createNote(test.ctx, "rem", {
        likes_count: 5,
        created_at: new Date(test.clock.now().getTime() + hour),
    });

    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), [[remote.id, 16]]);
});

Deno.test("only public statuses are counted today and yesterday, whatever else is used", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e", "f", "g"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);

    await use(test, "cats", accounts.slice(0, 5));
    for (const id of accounts.slice(5)) {
        await createNote(test.ctx, id, { visibility: "unlisted" }, [], ["cats"]);
    }
    for (const id of accounts.slice(0, 3)) {
        await createNote(
            test.ctx,
            id,
            {
                visibility: "unlisted",
                created_at: new Date("2026-01-07T09:00:00Z"),
            },
            [],
            ["cats"],
        );
    }

    await refreshTrendingTags(test.ctx);
    assertEquals(await tagNames(test), [["cats", 16]]);
});

Deno.test("a trending hashtag nobody used today stays until its peak has decayed below one", async () => {
    await using test = await open();
    const peak = (score: number) => ({
        score,
        max_score: score,
        max_score_at: new Date(test.clock.now().getTime() - 4 * hour),
    });
    for (const name of ["cats", "dogs"]) {
        await test.ctx.db.insertInto("tags").values({ name, display_name: name }).execute();
    }
    await test.ctx.db.insertInto("trending_tags").values([
        { name: "cats", ...peak(2) },
        { name: "dogs", ...peak(1.9) },
    ]).execute();

    await refreshTrendingTags(test.ctx);
    // A peak of 2 has halved to 1, which is enough.
    assertEquals(await tagNames(test), [["cats", 1]]);
});

Deno.test("when an author's statuses are equally popular, the newest trends", async () => {
    await using test = await open();
    const created_at = new Date(test.clock.now().getTime() - hour);
    const first = await createNote(test.ctx, "rem", { likes_count: 5, created_at });
    const second = await createNote(test.ctx, "rem", { likes_count: 5, created_at });

    await refreshTrendingStatuses(test.ctx);
    assertEquals(second.id > first.id, true);
    assertEquals(await trendingStatuses(test), [[second.id, 8]]);
});
