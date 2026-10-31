import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import { like } from "../interactions/likes.ts";
import { share } from "../interactions/shares.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { createTestContext } from "../testing/context.ts";
import { notified } from "./notifications.ts";
import { defaultPolicy, type Policy, savePolicy } from "./policy_queries.ts";

const dayMs = 24 * 60 * 60 * 1000;

/** alice, bob and carol, local users made just now, so new accounts. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    /** Posts a status as `accountId`, mentioning whoever `text` does, direct unless `public`. */
    const post = async (
        accountId: string,
        text: string,
        options: { inReplyToId?: string; public?: boolean } = {},
    ) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility: options.public ? undefined : "direct",
            inReplyToId: options.inReplyToId,
        });
        if (note === undefined) throw new Error("Not posted");

        await drain(test.ctx, queues);
        return note.id;
    };

    /** Sets `accountId`'s policy to the default, with `changes`. */
    const policy = (accountId: string, changes: Partial<Policy>) =>
        savePolicy(test.ctx, accountId, { ...defaultPolicy, ...changes });

    /**
     * The notifications of `accountId`, newest first, as their type, who did it, and whether their
     * policy filtered it.
     */
    const of = async (accountId: string) =>
        (await test.ctx.db.selectFrom("notifications").selectAll()
            .where("account_id", "=", accountId)
            .orderBy("id", "desc")
            .execute())
            .map((row) => `${row.type} ${row.from_account_id}${row.filtered ? " filtered" : ""}`);

    return { ...test, post, policy, of };
};

Deno.test("a direct mention from an account the user doesn't follow is filtered, and kept in a request", async () => {
    await using test = await open();

    // Counted in the request only once filtered.
    await test.post("bob", "@alice In public", { public: true });
    const first = await test.post("bob", "@alice Hi");
    const second = await test.post("bob", "@alice Hi again", { inReplyToId: first });
    assertEquals(await test.of("alice"), [
        "mention bob filtered",
        "mention bob filtered",
        "mention bob",
    ]);

    const requests = await test.ctx.db.selectFrom("notification_requests").selectAll().execute();
    assertEquals(
        requests.map((row) => [row.account_id, row.from_account_id, row.last_note_id]),
        [["alice", "bob", second]],
    );
    assertEquals(requests[0].notifications_count, 2);
});

Deno.test("a direct mention isn't filtered from an account the user follows, or answering them", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "carol");
    await test.post("carol", "@alice Hi");

    // A reply to alice's own direct status mentioning bob answers her.
    const asked = await test.post("alice", "@bob Hi");
    const answer = await test.post("bob", "@alice Hello", { inReplyToId: asked });
    await test.post("bob", "@alice Still me", { inReplyToId: answer });
    assertEquals(await test.of("alice"), ["mention bob", "mention bob", "mention carol"]);
});

Deno.test("a direct reply is filtered unless it is to the user's own direct status", async () => {
    await using test = await open();
    await follow(test.ctx, "alice", "carol");

    // carol's, not alice's.
    const carols = await test.post("carol", "@alice @bob Hi");
    await test.post("bob", "@alice @carol Hello", { inReplyToId: carols });
    // alice's, but public.
    const shown = await test.post("alice", "@bob Hi", { public: true });
    await test.post("bob", "@alice Hello", { inReplyToId: shown });

    assertEquals((await test.of("alice")).filter((each) => each.includes("bob")), [
        "mention bob filtered",
        "mention bob filtered",
    ]);
});

Deno.test("a policy that drops a notification wins over one that filters it", async () => {
    await using test = await open();
    const note = await test.post("alice", "Hi", { public: true });

    await test.policy("alice", { for_not_following: "filter", for_new_accounts: "drop" });
    await like(test.ctx, "bob", note);
    assertEquals(await test.of("alice"), []);

    await test.policy("alice", { for_not_following: "filter" });
    await like(test.ctx, "carol", note);
    assertEquals(await test.of("alice"), ["favourite carol filtered"]);
});

Deno.test("an account counts as a follower once it has followed for 3 days", async () => {
    await using test = await open();
    await test.policy("alice", { for_not_followers: "filter" });
    const first = await test.post("alice", "Hi", { public: true });
    const second = await test.post("alice", "Hi again", { public: true });

    await follow(test.ctx, "bob", "alice");
    await like(test.ctx, "bob", first);
    test.clock.advance(3 * dayMs);
    await like(test.ctx, "bob", second);
    assertEquals(await test.of("alice"), [
        "favourite bob",
        "favourite bob filtered",
        "follow bob filtered",
    ]);
});

Deno.test("an account is new for 30 days, unless the user follows it", async () => {
    await using test = await open();
    await test.policy("alice", { for_new_accounts: "filter" });
    const note = await test.post("alice", "Hi", { public: true });

    await like(test.ctx, "bob", note);
    await follow(test.ctx, "alice", "carol");
    await like(test.ctx, "carol", note);
    assertEquals(await test.of("alice"), ["favourite carol", "favourite bob filtered"]);

    test.clock.advance(30 * dayMs);
    const later = await test.post("alice", "Later", { public: true });
    await like(test.ctx, "bob", later);
    assertEquals((await test.of("alice"))[0], "favourite bob");
});

Deno.test("edits of boosted statuses aren't filtered, nor anything from limited accounts", async () => {
    await using test = await open();
    await test.policy("alice", { for_limited_accounts: "drop" });
    const note = await test.post("bob", "Hi", { public: true });
    await share(test.ctx, "alice", note);
    await like(test.ctx, "bob", await test.post("alice", "Mine", { public: true }));

    await test.policy("alice", { for_not_following: "drop", for_not_followers: "drop" });
    await editNote(test.ctx, "bob", note, { text: "Hello" });
    await drain(test.ctx, queues);
    assertEquals(await test.of("alice"), ["update bob", "favourite bob"]);
});

Deno.test("a filtered notification isn't grouped or streamed", async () => {
    await using test = await open();
    const heard: unknown[] = [];
    subscribe(test.ctx, notified, (message) => Promise.resolve(void heard.push(message)));
    await test.policy("alice", { for_not_following: "filter" });
    const note = await test.post("alice", "Hi", { public: true });

    await like(test.ctx, "bob", note);
    const [row] = await test.ctx.db.selectFrom("notifications").selectAll().execute();
    assertEquals([row.filtered, row.group_key, heard], [true, null, []]);
    // Only mentions are kept in requests.
    assertEquals(await test.ctx.db.selectFrom("notification_requests").selectAll().execute(), []);
});

Deno.test("an account that only asked to follow doesn't count as a follower", async () => {
    await using test = await open();
    await test.policy("alice", { for_not_followers: "filter" });
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    const note = await test.post("alice", "Hi", { public: true });

    await follow(test.ctx, "bob", "alice");
    test.clock.advance(3 * dayMs);
    await like(test.ctx, "bob", note);
    assertEquals(await test.of("alice"), ["favourite bob filtered", "follow_request bob filtered"]);
});
