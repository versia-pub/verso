import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { markConversationAs } from "../conversations/conversations.ts";
import { conversationPage } from "../conversations/conversation_queries.ts";
import type { Permission } from "../kernel/permissions.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { defaultPolicy, savePolicy } from "../notifications/policy_queries.ts";
import { createTestContext } from "../testing/context.ts";
import { directStreams } from "./direct.ts";
import { dispatcher } from "./dispatcher.ts";
import { openSession } from "./session.ts";

/** alice, bob and carol, local users, whose policies accept direct statuses from anyone. */
const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const direct = directStreams(test.ctx);
    dispatch.listen(direct);
    for (const id of ["alice", "bob", "carol"]) {
        await createLocalAccount(test.ctx, id);
        await savePolicy(test.ctx, id, { ...defaultPolicy, for_private_mentions: "accept" });
    }

    /**
     * What `accountId` is sent on their `direct` stream, as each event's type, whether the
     * conversation is unread, and its latest status.
     */
    const streaming = (accountId: string, permissions: readonly Permission[] = ["read:note"]) => {
        const sent: unknown[] = [];
        const viewer = {
            tokenId: "token",
            appId: "app",
            accountId,
            scopes: ["read" as const],
            forgetPermissions: () => {},
            permissions: () => Promise.resolve(new Set(permissions)),
        };
        const session = openSession(viewer, {
            send: (data) => {
                const { stream, event, payload } = JSON.parse(data);
                const { unread, last_status } = JSON.parse(payload);
                sent.push([stream.join(), event, unread, last_status.id]);
            },
            close: () => {},
        }, { stream: "direct" });
        direct.add(viewer, session);

        return sent;
    };

    /** Posts a direct status as `accountId`, mentioning whoever `text` does. */
    const post = async (accountId: string, text: string, inReplyToId?: string) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            visibility: "direct",
            inReplyToId,
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    return { ...test, idle: dispatch.idle, streaming, post };
};

Deno.test("a user is sent their conversation as it gets a status and is marked read or unread", async () => {
    await using test = await open();
    const alice = test.streaming("alice");
    const bob = test.streaming("bob");
    const carol = test.streaming("carol");

    const first = await test.post("bob", "@alice Hi");
    const reply = await test.post("alice", "@bob Hello", first);
    await editNote(test.ctx, "alice", reply, { text: "@bob Hello!" });
    await test.idle();
    assertEquals(alice, [["direct", "conversation", true, first], [
        "direct",
        "conversation",
        false,
        reply,
    ]]);
    assertEquals(bob.length, 2);
    assertEquals(carol, []);

    const [conversation] = await conversationPage(test.ctx, "alice", { limit: 1 });
    await markConversationAs(test.ctx, "alice", conversation.id, true);
    await markConversationAs(test.ctx, "alice", conversation.id, false);
    await test.idle();
    assertEquals(alice.slice(2), [
        ["direct", "conversation", true, reply],
        ["direct", "conversation", false, reply],
    ]);
});

Deno.test("a user is sent their conversation as it loses its latest status, but not once it has none", async () => {
    await using test = await open();
    const alice = test.streaming("alice");
    const first = await test.post("bob", "@alice Hi");
    const reply = await test.post("bob", "@alice Still there?", first);
    await test.idle();
    alice.length = 0;

    await removeNote(test.ctx, reply);
    await test.idle();
    assertEquals(alice, [["direct", "conversation", true, first]]);

    await removeNote(test.ctx, first);
    await test.idle();
    assertEquals(alice, [["direct", "conversation", true, first]]);
});

Deno.test("a user who may no longer read statuses isn't sent their conversations", async () => {
    await using test = await open();
    const alice = test.streaming("alice", []);

    await test.post("bob", "@alice Hi");
    await test.idle();
    assertEquals(alice, []);
});
