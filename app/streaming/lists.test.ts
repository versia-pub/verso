import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { follow } from "../graph/follows.ts";
import type { Permission } from "../kernel/permissions.ts";
import { addListAccounts, createList } from "../lists/lists.ts";
import { editNote, postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { createTestContext } from "../testing/context.ts";
import { dispatcher } from "./dispatcher.ts";
import { listStreams } from "./lists.ts";
import { openSession } from "./session.ts";
import { userStreams } from "./user.ts";

/** alice, who follows bob and carol, and has a list of bob's, which is exclusive. */
const open = async () => {
    const test = await createTestContext();
    const dispatch = dispatcher(test.ctx);
    const lists = listStreams(test.ctx);
    const users = userStreams(test.ctx);
    dispatch.listen(lists);
    dispatch.listen(users);
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    for (const id of ["bob", "carol"]) await follow(test.ctx, "alice", id);

    const list = await createList(test.ctx, "alice", {
        title: "Bob",
        replies_policy: "none",
        exclusive: true,
    });
    if (list === "full") throw new Error("Too many lists");
    await addListAccounts(test.ctx, "alice", list.id, ["bob"]);

    /**
     * What `accountId` is sent on the stream `stream`, of the list `listId` if it is `list`, as each
     * event's stream, type, and status or id.
     */
    const streaming = async (accountId: string, stream: string, listId?: string) => {
        const sent: unknown[] = [];
        const viewer = {
            tokenId: "token",
            appId: "app",
            accountId,
            scopes: ["read" as const],
            forgetPermissions: () => {},
            permissions: () => Promise.resolve(new Set<Permission>(["read:note"])),
        };
        const session = openSession(
            viewer,
            {
                send: (data) => {
                    const { stream, event, payload } = JSON.parse(data);
                    sent.push([
                        stream.join(),
                        event,
                        event === "delete" ? payload : JSON.parse(payload).id,
                    ]);
                },
                close: () => {},
            },
            { stream, list: listId },
            undefined,
            // Anyone may stream the list here, to show it is only sent to its owner.
            () => Promise.resolve(true),
        );
        // Whose list it is takes a query to know.
        await Promise.resolve();
        lists.add(viewer, session);
        users.add(viewer, session);

        return sent;
    };

    const post = async (accountId: string, text: string, inReplyToId?: string) => {
        const note = await postNote(test.ctx, accountId, {
            text,
            format: "text/plain",
            spoilerText: "",
            inReplyToId,
        });
        if (note === undefined) throw new Error("Not posted");
        await dispatch.idle();
        return note.id;
    };

    return { ...test, dispatch, listId: list.id, streaming, post };
};

Deno.test("a list's owner is sent its statuses as they are posted, edited and deleted", async () => {
    await using test = await open();
    const alice = await test.streaming("alice", "list", test.listId);
    const carol = await test.streaming("carol", "list", test.listId);

    const note = await test.post("bob", "Hi");
    await test.post("carol", "Not on the list");
    await editNote(test.ctx, "bob", note, { text: "Hello" });
    await test.dispatch.idle();
    await removeNote(test.ctx, note);
    await test.dispatch.idle();

    const list = `list,${test.listId}`;
    assertEquals(alice, [[list, "update", note], [list, "status.update", note], [
        list,
        "delete",
        note,
    ]]);
    assertEquals(carol, []);
});

Deno.test("a list's stream has the replies its policy allows, and home none of its exclusive members", async () => {
    await using test = await open();
    const list = await test.streaming("alice", "list", test.listId);
    const home = await test.streaming("alice", "user");

    const carols = await test.post("carol", "Hi");
    // To carol, who isn't in it, so not on a list whose policy is to show no replies.
    await test.post("bob", "Hi carol", carols);
    const own = await test.post("bob", "Hi");

    assertEquals(list, [[`list,${test.listId}`, "update", own]]);
    assertEquals(home, [["user", "update", carols]]);
});
