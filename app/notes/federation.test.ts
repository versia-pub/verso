import { assertEquals, assertRejects } from "@std/assert";
import { v0_6 } from "@versia/protocol";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import { fetchSigned } from "../federation/request.ts";
import type { CollectionProvider } from "../federation/registry.ts";
import { follow } from "../graph/follows.ts";
import { addFollowers } from "../graph/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { registry } from "../registry.ts";
import { createNetwork } from "../testing/network.ts";
import type { Visibility } from "../accounts/tables.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { audienceOf } from "./audience.ts";
import { noteType } from "./federation.ts";
import { editNote, postNote, removeNote } from "./notes.ts";
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

/** The notes and Deletes queued to be sent, with the instance each is for. */
const queued = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === "Note" || entity.type === "Delete");

/** The instance each of `queued` is for, and the type and id of what it is sent. */
const sent = async (ctx: Context) =>
    (await queued(ctx)).map(([domain, entity]) => [
        domain,
        entity.type,
        entity.id ?? entity.deleted,
    ]);

const post = (ctx: Context, accountId: string, text: string, visibility: Visibility = "public") =>
    postNote(ctx, accountId, { text, format: "text/plain", spoilerText: "", visibility });

Deno.test("a local note is a Versia Note, with who it mentions and what it replies to", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c1",
    });
    const quoted = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "c2",
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
            quote_id: quoted.id,
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
        quotes: "b.example:c2",
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

Deno.test("a note is shown on the instances of who it mentions, the followers, and who a public reply is to", async () => {
    await using test = await open();
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");
    // Bob is here, and frank only asked.
    await follow(test.ctx, "bob", "alice");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "frank", "alice");
    const note = (visibility: Visibility, replyTo: string | null = "erin") => ({
        account_id: "alice",
        visibility,
        in_reply_to_account_id: replyTo,
    });

    assertEquals(await audienceOf(test.ctx, note("public"), []), ["b.example", "c.example"]);
    assertEquals(await audienceOf(test.ctx, note("unlisted"), []), ["b.example", "c.example"]);
    assertEquals(await audienceOf(test.ctx, note("private"), []), ["b.example"]);
    assertEquals(await audienceOf(test.ctx, note("direct"), []), []);
    assertEquals(await audienceOf(test.ctx, note("direct"), ["alice", "bob", "erin"]), [
        "c.example",
    ]);
    assertEquals(await audienceOf(test.ctx, note("public", null), []), ["b.example"]);
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

Deno.test("a note is its author's instance's own", async () => {
    await using test = await open();
    const entity = await test.find((await createNote(test.ctx, "alice")).id, "");
    if (entity === undefined) throw new Error("No note");

    assertEquals(noteType.authority({ ...entity, author: "carol" }, "b.example"), "b.example");
    assertEquals(
        noteType.authority({ ...entity, author: "c.example:erin" }, "b.example"),
        "c.example",
    );
});

Deno.test("a posted note is sent to the instances of those it is shown to", async () => {
    await using test = await open();
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");

    const note = await post(test.ctx, "alice", "Hi @erin@c.example");
    const reply = await postNote(test.ctx, "bob", {
        text: "Hi",
        format: "text/plain",
        spoilerText: "",
        inReplyToId: (await createNote(test.ctx, "frank", {
            instance_id: "d.example",
            remote_id: "f1",
        })).id,
    });
    await post(test.ctx, "bob", "Just here");

    assertEquals(await sent(test.ctx), [
        ["b.example", "Note", note?.id],
        ["c.example", "Note", note?.id],
        ["d.example", "Note", reply?.id],
    ]);
    const [[, entity]] = await queued(test.ctx);
    // As sent, without the fields it leaves out.
    assertEquals(entity, JSON.parse(JSON.stringify(await test.find(note?.id ?? "", ""))));
});

Deno.test("an edited note is sent again, whole, to those it is shown to now", async () => {
    await using test = await open();
    const note = await post(test.ctx, "alice", "Hi", "direct");
    if (note === undefined) throw new Error("Not posted");

    await editNote(test.ctx, "alice", note.id, { text: "Hi @erin@c.example" });
    await editNote(test.ctx, "alice", note.id, { text: "Hi @erin@c.example" });

    assertEquals(await sent(test.ctx), [["c.example", "Note", note.id]]);
    const [[, entity]] = await queued(test.ctx);
    assertEquals(entity, JSON.parse(JSON.stringify(await test.find(note.id, "c.example"))));
});

Deno.test("a deleted local note is deleted where it was sent, and a remote one nowhere", async () => {
    await using test = await open();
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");
    const parent = await createNote(test.ctx, "frank", {
        instance_id: "d.example",
        remote_id: "f1",
    });
    const note = await createNote(test.ctx, "alice", {
        visibility: "unlisted",
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "frank",
    }, ["erin"]);
    const direct = await createNote(test.ctx, "alice", { visibility: "direct" });
    // Its own instance tells the others it is gone, so Verso doesn't, even to erin.
    const remote = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "c1" },
        ["erin"],
    );

    for (const id of [note.id, direct.id, remote.id]) await removeNote(test.ctx, id);

    assertEquals(await sent(test.ctx), [
        ["b.example", "Delete", note.id],
        ["c.example", "Delete", note.id],
        ["d.example", "Delete", note.id],
    ]);
    const [[, entity]] = await queued(test.ctx);
    assertEquals(entity, {
        type: "Delete",
        created_at: test.clock.now().toISOString(),
        author: "alice",
        deleted_type: "Note",
        deleted: note.id,
    });
});

Deno.test("a note reaches the instances of more followers than one query can name", async () => {
    await using test = await open();
    const instances = ["e0.example", "e1.example", "e2.example"];
    for (const domain of instances) await createInstance(test.ctx, domain);
    // More than the 65,535 values Postgres lets one query bind.
    await addFollowers(test.ctx, "alice", 70_000, [...instances, null]);

    const note = await post(test.ctx, "alice", "Hi", "private");

    assertEquals((await sent(test.ctx)).map(([domain]) => domain), ["b.example", ...instances]);
    assertEquals(await test.find(note?.id ?? "", "e1.example") === undefined, false);
});

Deno.test("a note's replies and quotes are the public and unlisted ones, oldest first", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const links = (kind: "replies" | "quotes") =>
        kind === "replies"
            ? { in_reply_to_id: note.id, in_reply_to_account_id: "alice" }
            : { quote_id: note.id };
    const collection = async (
        kind: "replies" | "quotes",
        id = note.id,
        requester = "b.example",
        page = { offset: 0, limit: 40 },
    ) => {
        const provider: CollectionProvider | undefined = noteType.collections?.[kind];
        if (provider === undefined) throw new Error(`Notes have no ${kind}`);
        return await provider(test.ctx, id, page, requester);
    };

    for (const kind of ["replies", "quotes"] as const) {
        const own = await createNote(test.ctx, "bob", { ...links(kind), visibility: "unlisted" });
        const remote = await createNote(test.ctx, "carol", {
            ...links(kind),
            instance_id: "b.example",
            remote_id: `c-${kind}`,
        });
        await createNote(test.ctx, "bob", { ...links(kind), visibility: "private" });
        await createNote(test.ctx, "bob", { ...links(kind), visibility: "direct" });

        assertEquals(await collection(kind), {
            author: "alice",
            total: 2,
            items: [own.id, `b.example:c-${kind}`],
        }, kind);
        assertEquals(await collection(kind, note.id, "c.example", { offset: 1, limit: 1 }), {
            author: "alice",
            total: 2,
            items: [`b.example:c-${kind}`],
        });
        assertEquals((await collection(kind, remote.id))?.items, undefined);
    }
});

Deno.test("a note's replies are only for the instances that may see the note", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });
    const reply = await createNote(test.ctx, "bob", {
        in_reply_to_id: note.id,
        in_reply_to_account_id: "alice",
    });
    const replies = (id: string, requester: string) => {
        const provider: CollectionProvider | undefined = noteType.collections?.replies;
        return provider?.(test.ctx, id, { offset: 0, limit: 40 }, requester);
    };

    // Carol, on b.example, follows alice.
    assertEquals((await replies(note.id, "b.example"))?.items, [reply.id]);
    assertEquals(await replies(note.id, "c.example"), undefined);
    assertEquals(await replies("missing", "b.example"), undefined);
});

Deno.test("a note's collections are served to other instances", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    const url = new URL(`https://a.test/.versia/v0.6/entities/Note/${note.id}/collections/quotes`);

    const reply = await fetchSigned(network.instances["b.test"].ctx, url);
    assertEquals([reply.status, JSON.parse(new TextDecoder().decode(reply.body))], [
        200,
        { author: "alice", total: 0, items: [] },
    ]);
});
