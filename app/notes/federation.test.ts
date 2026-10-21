import { assertEquals, assertRejects } from "@std/assert";
import { v0_6 } from "@versia/protocol";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import type { CollectionProvider } from "../federation/registry.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { audienceOf, noteType } from "./federation.ts";
import { createNote } from "./testing.ts";

/** Alice and bob here; carol on b.example, who follows alice, and erin on c.example. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await createInstance(test.ctx, "c.example");
    await createRemoteAccount(test.ctx, "erin", "c.example");
    await follow(test.ctx, "carol", "alice");

    const find = (id: string, requester: string) => {
        if (noteType.find === undefined) throw new Error("Notes can't be fetched");
        return noteType.find(test.ctx, id, requester);
    };

    return { ...test, find };
};

Deno.test("a local note is a Versia Note, with who it mentions and what it replies to", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
    });
    const note = await createNote(
        test.ctx,
        "alice",
        {
            visibility: "unlisted",
            content: "Hi *@bob*",
            content_format: "text/markdown",
            content_html: "<p>Hi <em>@bob</em></p>",
            spoiler_text: "Greeting",
            sensitive: true,
            in_reply_to_id: parent.id,
            in_reply_to_account_id: "carol",
        },
        ["bob", "carol"],
    );

    const entity = await test.find(note.id, "");
    assertEquals(entity, {
        type: "Note",
        id: note.id,
        created_at: test.clock.now().toISOString(),
        author: "alice",
        category: "microblog",
        content: {
            "text/markdown": { content: "Hi *@bob*", remote: false },
            "text/html": { content: "<p>Hi <em>@bob</em></p>", remote: false },
        },
        group: "public",
        is_sensitive: true,
        subject: "Greeting",
        mentions: ["bob", "b.example:carol"],
        replies_to: "b.example:c1",
        attachments: [],
        previews: [],
    });
    assertEquals(v0_6.Note.safeParse(entity).success, true);
});

Deno.test("a local reply is to a bare id, and a note without a warning has no subject", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "bob");
    const note = await createNote(test.ctx, "alice", {
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "bob",
    });

    const entity = await test.find(note.id, "");
    assertEquals([entity?.replies_to, entity?.subject, entity?.is_sensitive], [
        parent.id,
        undefined,
        false,
    ]);
});

Deno.test("a reply to a remote note without its instance's id is a mistake", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "carol", { instance_id: "b.example" });
    const note = await createNote(test.ctx, "alice", {
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "carol",
    });

    await assertRejects(() => test.find(note.id, ""), Error, "has no remote id");
});

Deno.test("a private note is for followers, and a direct one only for those it mentions", async () => {
    await using test = await open();
    const group = async (visibility: "public" | "unlisted" | "private" | "direct") => {
        const note = await createNote(test.ctx, "alice", { visibility }, ["erin"]);
        return (await test.find(note.id, "c.example"))?.group;
    };

    assertEquals(await group("public"), "public");
    assertEquals(await group("unlisted"), "public");
    assertEquals(await group("private"), "followers");
    assertEquals(await group("direct"), undefined);
});

Deno.test("a note is given only to instances with someone it is shown to", async () => {
    await using test = await open();
    const seen = async (visibility: "public" | "private" | "direct", mentionIds: string[] = []) => {
        const note = await createNote(test.ctx, "alice", { visibility }, mentionIds);
        const requesters = ["", "b.example", "c.example", "d.example"];
        const by = [];
        for (const requester of requesters) {
            if (await test.find(note.id, requester)) by.push(requester || "anyone");
        }
        return by;
    };

    assertEquals(await seen("public"), ["anyone", "b.example", "c.example", "d.example"]);
    assertEquals(await seen("private"), ["b.example"]);
    assertEquals(await seen("private", ["erin"]), ["b.example", "c.example"]);
    assertEquals(await seen("direct"), []);
    assertEquals(await seen("direct", ["erin"]), ["c.example"]);
});

Deno.test("only local notes that exist are given", async () => {
    await using test = await open();
    const remote = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
    });

    assertEquals(await test.find(remote.id, "b.example"), undefined);
    assertEquals(await test.find("missing", "b.example"), undefined);
});

Deno.test("a note is shown to who it mentions, the followers, and who a public reply is to", async () => {
    await using test = await open();
    await follow(test.ctx, "bob", "alice");
    const note = (visibility: "public" | "unlisted" | "private" | "direct") => ({
        account_id: "alice",
        visibility,
        in_reply_to_account_id: "erin",
    });
    const audience = async (visibility: "public" | "unlisted" | "private" | "direct") =>
        (await audienceOf(test.ctx, note(visibility), ["alice", "carol"])).toSorted();

    assertEquals(await audience("public"), ["bob", "carol", "erin"]);
    assertEquals(await audience("unlisted"), ["bob", "carol", "erin"]);
    assertEquals(await audience("private"), ["bob", "carol"]);
    assertEquals(await audience("direct"), ["carol"]);
    const unreplied = { ...note("public"), in_reply_to_account_id: null };
    assertEquals((await audienceOf(test.ctx, unreplied, [])).toSorted(), ["bob", "carol"]);
});

Deno.test("a user's outbox is their public and unlisted notes, oldest first", async () => {
    await using test = await open();
    const user = registry.types.get("User");
    const outbox: CollectionProvider | undefined = user?.collections?.outbox;
    if (outbox === undefined) throw new Error("Users have no outbox");

    const ids = [];
    for (const visibility of ["public", "private", "unlisted", "direct", "public"] as const) {
        test.clock.advance(1);
        ids.push((await createNote(test.ctx, "alice", { visibility })).id);
    }
    await createNote(test.ctx, "bob");
    const page = async (offset: number, limit: number) => {
        const collection = await outbox(test.ctx, "alice", { offset, limit }, "b.example");
        return collection && {
            ...collection,
            items: collection.items.map((item) => (item as { id: string }).id),
        };
    };

    assertEquals(await page(0, 2), { author: "alice", total: 3, items: [ids[0], ids[2]] });
    assertEquals(await page(2, 2), { author: "alice", total: 3, items: [ids[4]] });
    assertEquals(await outbox(test.ctx, "carol", { offset: 0, limit: 40 }, "b.example"), undefined);
    assertEquals(
        await outbox(test.ctx, "nobody", { offset: 0, limit: 40 }, "b.example"),
        undefined,
    );
});

Deno.test("notes from other instances aren't taken yet, and are their authors' instances' own", async () => {
    await using test = await open();
    const entity = await test.find((await createNote(test.ctx, "alice")).id, "");
    if (entity === undefined) throw new Error("No note");
    const sender = { domain: "b.example", instanceId: "b.example", fetched: true };

    await assertRejects(() => noteType.receive(test.ctx, entity, sender), PermanentFailure);
    assertEquals(noteType.authority({ ...entity, author: "carol" }, "b.example"), "b.example");
    assertEquals(
        noteType.authority({ ...entity, author: "c.example:erin" }, "b.example"),
        "c.example",
    );
});
