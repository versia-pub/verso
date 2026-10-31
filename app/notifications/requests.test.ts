import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { conversationPage } from "../conversations/conversation_queries.ts";
import { like } from "../interactions/likes.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { postNote } from "../notes/notes.ts";
import { createTestContext } from "../testing/context.ts";
import { defaultPolicy, savePolicy } from "./policy_queries.ts";
import { requestPage } from "./request_queries.ts";
import { acceptRequests, dismissRequests, notificationsMerged } from "./requests.ts";

/** alice, whose policy filters accounts she doesn't follow, and bob and carol, whom she doesn't. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await savePolicy(test.ctx, "alice", { ...defaultPolicy, for_not_following: "filter" });

    /** Posts a status as `accountId`, mentioning whoever `text` does, direct unless `public`. */
    const post = async (accountId: string, text: string, options: { public?: boolean } = {}) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility: options.public ? undefined : "direct",
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    /** alice's notifications, newest first, as their type, who did it, and if they're filtered. */
    const of = async () =>
        (await test.ctx.db.selectFrom("notifications").selectAll()
            .where("account_id", "=", "alice")
            .orderBy("id", "desc")
            .execute())
            .map((row) => `${row.type} ${row.from_account_id}${row.filtered ? " filtered" : ""}`);

    /** alice's request from `fromId`. */
    const requestFrom = async (fromId: string) => {
        const requests = await requestPage(test.ctx, "alice", { limit: 40 });
        const request = requests.find((each) => each.from_account_id === fromId);
        if (request === undefined) throw new Error(`No request from ${fromId}`);
        return request;
    };

    return { ...test, post, of, requestFrom };
};

Deno.test("accepting a request shows its account's filtered notifications, and lets the later ones through", async () => {
    await using test = await open();
    const heard: unknown[] = [];
    subscribe(
        test.ctx,
        notificationsMerged,
        (message) => Promise.resolve(void heard.push(message)),
    );
    const own = await test.post("alice", "Hi", { public: true });
    const direct = await test.post("bob", "@alice Hi");
    await like(test.ctx, "bob", own);
    await test.post("carol", "@alice Hi");

    await acceptRequests(test.ctx, "alice", []);
    await acceptRequests(test.ctx, "alice", [await test.requestFrom("bob")]);
    assertEquals(await test.of(), ["mention carol filtered", "favourite bob", "mention bob"]);
    assertEquals(heard, [{ accountId: "alice" }]);
    assertEquals(
        (await requestPage(test.ctx, "alice", { limit: 40 })).map((row) => row.from_account_id),
        ["carol"],
    );
    const [conversation] = await conversationPage(test.ctx, "alice", { limit: 40 });
    assertEquals([conversation.last_note_id, conversation.unread], [direct, true]);

    // Even a policy that drops them lets them through now.
    await savePolicy(test.ctx, "alice", { ...defaultPolicy, for_not_following: "drop" });
    await test.post("bob", "@alice Again");
    assertEquals((await test.of())[0], "mention bob");
});

Deno.test("dismissing a request deletes its account's filtered notifications, and filters the later ones", async () => {
    await using test = await open();
    await test.post("bob", "@alice In public", { public: true });
    // Filtered too, as alice doesn't follow bob.
    assertEquals(await test.of(), ["mention bob filtered"]);
    await savePolicy(test.ctx, "alice", defaultPolicy);
    await test.post("bob", "@alice In public again", { public: true });
    await test.post("bob", "@alice Hi");
    await test.post("carol", "@alice Hi");

    await dismissRequests(test.ctx, "alice", [await test.requestFrom("bob")]);
    assertEquals(await test.of(), ["mention carol filtered", "mention bob"]);
    assertEquals(
        (await requestPage(test.ctx, "alice", { limit: 40 })).map((row) => row.from_account_id),
        ["carol"],
    );

    await test.post("bob", "@alice Again");
    assertEquals((await test.of())[0], "mention bob filtered");
    assertEquals((await test.requestFrom("bob")).notifications_count, 1);
});
