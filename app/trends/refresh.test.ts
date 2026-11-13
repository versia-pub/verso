import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { silence, unsilence } from "../moderation/silences.ts";
import { suspend, unsuspend } from "../moderation/suspensions.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { setLink } from "../previews/card_queries.ts";
import { createCard } from "../previews/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { refreshTrendingLinks, refreshTrendingStatuses, refreshTrendingTags } from "./refresh.ts";
import { approvedTrendingStatuses } from "./trend_queries.ts";

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

const sharers = ["alice", "b", "c", "d", "e"];

/** The cards that are trending, with their scores. */
const trendingCardScores = async (test: Awaited<ReturnType<typeof open>>) =>
    (await test.ctx.db.selectFrom("trending_links").selectAll().orderBy("card_id").execute())
        .map((row) => row.score);

/** Statuses by `accounts`, all showing one card, which is returned. */
const share = async (
    test: Awaited<ReturnType<typeof open>>,
    accounts: readonly string[],
    note: Parameters<typeof createNote>[2] = {},
    card: Parameters<typeof createCard>[2] = {},
) => {
    const notes = [];
    for (const account of accounts) notes.push((await createNote(test.ctx, account, note)).id);

    return { cardId: await createCard(test.ctx, notes, card), notes };
};

Deno.test("a link trends when enough accounts shared it today, more than yesterday", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);

    const { cardId } = await share(test, sharers);
    await share(test, sharers.slice(0, 4));
    // Five yesterday, as many as today.
    await share(test, sharers, { created_at: new Date("2026-01-07T09:00:00Z") });

    await refreshTrendingLinks(test.ctx);
    const rows = await test.ctx.db.selectFrom("trending_links").selectAll().execute();
    assertEquals(rows.map((row) => [row.card_id, row.score]), [[cardId, 16]]);
});

Deno.test("boosts count for the account that boosted, not for the status they share", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);

    // Alice shared it, and four others boosted her status.
    const { notes } = await share(test, ["alice"]);
    for (const id of sharers.slice(1, 4)) await createShare(test.ctx, id, notes[0]);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);

    // Alice boosting her own status again is by the same account, which counts once.
    await createShare(test.ctx, "alice", notes[0]);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);

    await createShare(test.ctx, "e", notes[0]);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [16]);
});

Deno.test("only public statuses without a content warning count toward a link trending", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);

    for (const note of [{ visibility: "unlisted" }, { sensitive: true }, { spoiler_text: "cw" }]) {
        // Four public statuses, and a fifth that mustn't count, all for one card.
        const { cardId } = await share(test, sharers.slice(0, 4));
        const fifth = await createNote(
            test.ctx,
            "e",
            note as Parameters<typeof createNote>[2],
        );
        await setLink(test.ctx, fifth.id, cardId, "https://news.example/story");
    }
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);

    // A public fifth would have counted.
    const { cardId } = await share(test, sharers.slice(0, 4));
    const fifth = await createNote(test.ctx, "e");
    await setLink(test.ctx, fifth.id, cardId, "https://news.example/story");
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [16]);
});

Deno.test("a link counts only if its card is for an article with a title, description, image and provider", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);

    const incomplete = [
        { link_type: "unknown" as const },
        { title: "" },
        { description: "" },
        { provider_name: "" },
    ];
    for (const card of incomplete) await share(test, sharers, {}, card);

    const noImage = await share(test, sharers);
    await test.ctx.db.updateTable("preview_cards").set({ image_id: null })
        .where("id", "=", noImage.cardId).execute();

    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);
});

Deno.test("a link stays while its peak decays, halving every eight hours", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);
    await share(test, sharers);

    await refreshTrendingLinks(test.ctx);
    test.clock.advance(8 * hour);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [8]);
    const [row] = await test.ctx.db.selectFrom("trending_links").selectAll().execute();
    assertEquals(row.max_score, 16);
    assertEquals(row.max_score_at, new Date("2026-01-08T12:00:00Z"));

    // Another day on, nobody shared it today, and the peak is under 1 after 32 hours more.
    test.clock.advance(32 * hour);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);
});

Deno.test("a link's peak moves to now when a higher score is reached", async () => {
    await using test = await open();
    for (const id of [...sharers.slice(1), "f"]) await createLocalAccount(test.ctx, id);
    const { notes } = await share(test, sharers);

    await refreshTrendingLinks(test.ctx);
    test.clock.advance(hour);
    await createShare(test.ctx, "f", notes[0]);
    await refreshTrendingLinks(test.ctx);

    const [row] = await test.ctx.db.selectFrom("trending_links").selectAll().execute();
    assertEquals(row.score, 25);
    assertEquals(row.max_score, 25);
    assertEquals(row.max_score_at, new Date("2026-01-08T13:00:00Z"));
});

Deno.test("a trending link nobody shared today stays until its peak has decayed below one", async () => {
    await using test = await open();
    for (const id of sharers.slice(1)) await createLocalAccount(test.ctx, id);
    await share(test, sharers);
    await refreshTrendingLinks(test.ctx);

    // After 16 hours it is the next day, and the peak of 16 has halved twice.
    test.clock.advance(16 * hour);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [4]);
});

Deno.test("suspended and silenced accounts' statuses don't count toward hashtags trending", async () => {
    await using test = await open();
    const accounts = ["alice", "b", "c", "d", "e"];
    for (const id of accounts.slice(1)) await createLocalAccount(test.ctx, id);
    await use(test, "cats", accounts);

    /** The names of the hashtags trending after a refresh. */
    const trending = async () => {
        await refreshTrendingTags(test.ctx);

        return (await tagNames(test)).map(([name]) => name);
    };

    await silence(test.ctx, "e");
    assertEquals(await trending(), []);

    await unsilence(test.ctx, "e");
    await suspend(test.ctx, "d");
    assertEquals(await trending(), []);

    await unsuspend(test.ctx, "d");
    assertEquals(await trending(), ["cats"]);
});

Deno.test("suspended and silenced accounts' statuses don't trend, and suspended ones stop showing at once", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    const local = await createNote(test.ctx, "alice", { likes_count: 10 });
    const remote = await createNote(test.ctx, "rem", { likes_count: 10 });
    const shown = async () =>
        (await approvedTrendingStatuses(test.ctx, true, null, 40, 0)).map((note) => note.id);

    await refreshTrendingStatuses(test.ctx);
    assertEquals((await shown()).toSorted(), [local.id, remote.id].toSorted());

    await suspend(test.ctx, "alice");
    await silence(test.ctx, "rem");
    assertEquals(await shown(), [remote.id]);

    await refreshTrendingStatuses(test.ctx);
    assertEquals(await trendingStatuses(test), []);
});

Deno.test("a link shared by a suspended or silenced account, or boosted from one, doesn't count", async () => {
    await using test = await open();
    for (const id of [...sharers.slice(1), "f", "g", "h"]) await createLocalAccount(test.ctx, id);

    // Alice shared one, and the others boosted her status, but e is silenced.
    const first = await share(test, ["alice"]);
    for (const id of sharers.slice(1)) await createShare(test.ctx, id, first.notes[0]);
    await silence(test.ctx, "e");
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), []);

    await createShare(test.ctx, "f", first.notes[0]);
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [16]);

    // Boosts of a suspended account's status don't count either, though there are enough.
    const second = await share(test, ["g"]);
    for (const id of ["b", "c", "d", "f", "h"]) await createShare(test.ctx, id, second.notes[0]);
    await suspend(test.ctx, "g");
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [16]);

    await unsuspend(test.ctx, "g");
    await refreshTrendingLinks(test.ctx);
    assertEquals(await trendingCardScores(test), [16, 25]);
});
