import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { postNote } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { setThreadMuted } from "../notes/thread_mutes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { conversationRoutes } from "./routes.ts";

/** alice, bob, carol and dave, local users. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, conversationRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "carol", "dave"]) await createLocalAccount(test.ctx, id);

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

    /** Sends a request as `as`. */
    const request = async (method: string, path: string, as = "alice") => {
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, as)}` },
        });
        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    type Shown = {
        id: string;
        unread: boolean;
        accounts: { id: string }[];
        last_status: { id: string };
    };

    /** `as`'s conversations, as whether each is unread, who else is in it, and its last status. */
    const conversations = async (as: string) =>
        ((await request("GET", "/api/v1/conversations", as)).body as Shown[]).map((each) => [
            each.unread,
            each.accounts.map((account) => account.id),
            each.last_status.id,
        ]);

    return { ...test, post, request, conversations };
};

Deno.test("a direct status is in a conversation of its author's and of each user it mentions", async () => {
    await using test = await open();

    const first = await test.post("alice", "@bob @carol Hi");
    assertEquals(await test.conversations("alice"), [[false, ["bob", "carol"], first]]);
    assertEquals(await test.conversations("bob"), [[true, ["alice", "carol"], first]]);

    // A reply between the same accounts is in the same conversation, read by whoever posted it.
    const reply = await test.post("bob", "@alice @carol Hello", first);
    assertEquals(await test.conversations("alice"), [[true, ["bob", "carol"], reply]]);
    assertEquals(await test.conversations("bob"), [[false, ["alice", "carol"], reply]]);
    assertEquals(await test.conversations("carol"), [[true, ["alice", "bob"], reply]]);
    assertEquals(await test.conversations("dave"), []);
});

Deno.test("each thread and each set of accounts has a conversation of its own", async () => {
    await using test = await open();

    const first = await test.post("alice", "@bob Hi");
    const aside = await test.post("alice", "@bob @dave Hi", first);
    const other = await test.post("alice", "@bob Another");
    const alone = await test.post("alice", "Note to self");

    assertEquals(await test.conversations("alice"), [
        [false, ["alice"], alone],
        [false, ["bob"], other],
        [false, ["bob", "dave"], aside],
        [false, ["bob"], first],
    ]);
});

Deno.test("a user who hides the author or mutes the thread isn't added to the conversation", async () => {
    await using test = await open();
    await block(test.ctx, "carol", "alice");
    const first = await test.post("alice", "@bob @carol Hi");
    await setThreadMuted(test.ctx, "bob", first, true);

    await test.post("alice", "@bob @carol Again", first);
    assertEquals(await test.conversations("carol"), []);
    assertEquals(await test.conversations("bob"), [[true, ["alice", "carol"], first]]);
});

Deno.test("deleting a conversation's latest status leaves the one before, and deleting all of them, none", async () => {
    await using test = await open();
    const first = await test.post("alice", "@bob Hi");
    const reply = await test.post("bob", "@alice Hello", first);

    await removeNote(test.ctx, reply);
    assertEquals(await test.conversations("alice"), [[true, ["bob"], first]]);
    await removeNote(test.ctx, first);
    assertEquals(await test.conversations("alice"), []);
    assertEquals(await test.conversations("bob"), []);
});

Deno.test("a user pages through their conversations, marks them read or unread, and removes them", async () => {
    await using test = await open();
    const older = await test.post("bob", "@alice Hi");
    const newer = await test.post("carol", "@alice Hi");

    const page = await test.request("GET", "/api/v1/conversations?limit=1");
    assertEquals(page.body.map((each: { last_status: { id: string } }) => each.last_status.id), [
        newer,
    ]);
    const next = new URL(page.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    assertEquals(next.searchParams.get("max_id"), newer);
    const rest = await test.request("GET", next.pathname + next.search);
    assertEquals(rest.body.map((each: { last_status: { id: string } }) => each.last_status.id), [
        older,
    ]);

    const id = page.body[0].id;
    assertEquals(
        (await test.request("POST", `/api/v1/conversations/${id}/read`)).body.unread,
        false,
    );
    assertEquals(
        (await test.request("POST", `/api/v1/conversations/${id}/unread`)).body.unread,
        true,
    );
    assertEquals(
        (await test.request("POST", `/api/v1/conversations/${id}/read`, "bob")).status,
        404,
    );
    assertEquals((await test.request("DELETE", `/api/v1/conversations/${id}`, "bob")).status, 404);

    assertEquals((await test.request("DELETE", `/api/v1/conversations/${id}`)).body, {});
    assertEquals(await test.conversations("alice"), [[true, ["bob"], older]]);

    // A new status in it brings it back.
    const again = await test.post("carol", "@alice Still there?", newer);
    assertEquals((await test.conversations("alice"))[0], [true, ["carol"], again]);
});
