import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { silence } from "../moderation/silences.ts";
import { suspend } from "../moderation/suspensions.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { decideTag } from "./review.ts";
import { hashtagsUsedBy, setTagTrendable } from "./trend_queries.ts";

const accounts = ["alice", "b", "c", "d", "e"];

Deno.test("hashtags are used by enough accounts, in public statuses that aren't boosts", async () => {
    await using test = await createTestContext();
    for (const id of accounts) await createLocalAccount(test.ctx, id);
    const since = new Date("2025-12-31T00:00:00Z");

    // One account five times is one account.
    for (let times = 0; times < 5; times++) {
        await createNote(test.ctx, "alice", {}, [], ["owls"]);
    }
    for (const id of accounts) await createNote(test.ctx, id, {}, [], ["cats"]);
    const parent = await createNote(test.ctx, "alice");
    for (const id of accounts) {
        await createNote(test.ctx, id, { reblog_of_id: parent.id }, [], ["boosted"]);
        await createNote(test.ctx, id, { visibility: "unlisted" }, [], ["quiet"]);
    }

    assertEquals(await hashtagsUsedBy(test.ctx, since, 5), ["cats"]);
    assertEquals((await hashtagsUsedBy(test.ctx, since, 1)).sort(), ["cats", "owls"]);
});

Deno.test("a hashtag's name is looked up in lower case, with or without its #", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createNote(test.ctx, "alice", {}, [], ["cats"]);
    const trendable = async () =>
        (await test.ctx.db.selectFrom("tags").select("trendable").executeTakeFirstOrThrow())
            .trendable;

    assertEquals(await setTagTrendable(test.ctx, "Cats", true), true);
    assertEquals(await trendable(), true);
    assertEquals(await decideTag(test.ctx, "#cats", false), true);
    assertEquals(await trendable(), false);
    assertEquals(await setTagTrendable(test.ctx, "dogs", true), false);
});

Deno.test("suspended and silenced accounts' uses of a hashtag don't count", async () => {
    await using test = await createTestContext();
    for (const id of accounts) await createLocalAccount(test.ctx, id);
    const since = new Date("2025-12-31T00:00:00Z");
    for (const id of accounts) await createNote(test.ctx, id, {}, [], ["cats"]);

    await silence(test.ctx, "d");
    await suspend(test.ctx, "e");
    assertEquals(await hashtagsUsedBy(test.ctx, since, 4), []);
    assertEquals(await hashtagsUsedBy(test.ctx, since, 3), ["cats"]);
});
