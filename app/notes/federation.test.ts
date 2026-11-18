import { assertEquals, assertRejects } from "@std/assert";
import { v0_7 } from "@versia/protocol";
import { encode } from "fast-png";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { audienceInstances } from "../federation/deliver.ts";
import { queuedDeliveries } from "../federation/testing.ts";
import { fetchSigned } from "../federation/request.ts";
import type { CollectionProvider } from "../federation/registry.ts";
import { block } from "../graph/blocks.ts";
import { follow } from "../graph/follows.ts";
import { addFollowers } from "../graph/testing.ts";
import { setNoteEmojis } from "../emojis/emoji_queries.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { findMedia } from "../media/media_queries.ts";
import { upload } from "../media/uploads.ts";
import { memoryFiles } from "../kernel/files.ts";
import { registry } from "../registry.ts";
import { createNetwork } from "../testing/network.ts";
import type { Visibility } from "../kernel/visibility.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext, type TestContextOptions } from "../testing/context.ts";
import { audienceOf } from "./audience.ts";
import { noteType } from "./federation.ts";
import { editNote, postNote } from "./notes.ts";
import { removeNote } from "./removal.ts";
import { pin } from "./pins.ts";
import { createNote } from "./testing.ts";

/** The type of a Note. */
const noteName = "pub.versia:social/Note";

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

/** Alice and bob are local; carol, who follows alice, is on b.example; erin is on c.example. */
const open = async (options: TestContextOptions = {}) => {
    const test = await createTestContext(options);

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

/** The Notes and Deletes queued for delivery, with the instance each is for. */
const queued = async (ctx: Context) =>
    (await queuedDeliveries(ctx))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === noteName || entity.type === "Delete");

/** The instance each of `queued` is for, and the type and id of the entity sent. */
const sent = async (ctx: Context) =>
    (await queued(ctx)).map(([domain, entity]) => [
        domain,
        entity.type,
        entity.id ?? entity.deleted,
    ]);

const post = (ctx: Context, accountId: string, text: string, visibility: Visibility = "public") =>
    postNote(ctx, accountId, { text, format: "text/plain", spoilerText: "", visibility });

Deno.test("a local note is a Versia Note, with who it mentions, what it replies to and its emojis", async () => {
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
    await setNoteEmojis(test.ctx, note.id, [await createLocalEmoji(test.ctx, "blob")]);

    const entity = await test.find(note.id, "");
    assertEquals(entity, {
        type: noteName,
        id: note.id,
        created_at: test.clock.now().toISOString(),
        updated_at: undefined,
        author: "social.example:alice",
        category: "microblog",
        content: "<p>Hi <em>@bob</em></p>",
        visibility: "unlisted",
        is_sensitive: true,
        subject: "Greeting",
        mentions: ["social.example:bob", "b.example:carol"],
        replies_to: "b.example:c1",
        quoting: "b.example:c2",
        url: `https://social.example/@alice/${note.id}`,
        attachments: [],
        previews: [],
        extensions: {
            "pub.versia:custom_emojis": {
                emojis: [{
                    name: ":blob:",
                    content: {
                        url: "https://social.example/media/emoji-blob",
                        media_type: "image/png",
                    },
                }],
            },
        },
    });
    assertEquals(v0_7.Note.safeParse(entity).success, true);
});

Deno.test("a local reply is to a reference with a host, and a note without a warning or emojis has neither", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "bob");
    const note = await createNote(test.ctx, "alice", {
        in_reply_to_id: parent.id,
        in_reply_to_account_id: "bob",
    });

    const entity = await test.find(note.id, "");
    assertEquals(
        [entity?.replies_to, entity?.subject, entity?.is_sensitive, entity?.extensions],
        [`social.example:${parent.id}`, undefined, false, undefined],
    );
});

Deno.test("a local note's files are at the URLs they are served at, as what they are served as", async () => {
    await using test = await open();
    const picture = await upload(test.ctx, "alice", {
        file: new Blob([png]),
        mediaType: "image/png",
        description: "A red square",
    });
    const video = await upload(test.ctx, "alice", {
        file: new Blob([zip, new Uint8Array([1])]),
        mediaType: "video/mp4",
    });
    const file = await upload(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "application/zip",
    });
    await drain(test.ctx, queues);
    const note = await postNote(test.ctx, "alice", {
        text: "",
        format: "text/plain",
        spoilerText: "",
        visibility: "public",
        mediaIds: [video.id, picture.id, file.id],
    });
    if (note === undefined) throw new Error("Not posted");
    const kept = await findMedia(test.ctx, picture.id);

    const entity = await test.find(note.id, "");

    // As sent, without the omitted fields.
    assertEquals(JSON.parse(JSON.stringify(entity?.attachments)), [
        {
            url: `https://social.example/media/${video.sha256}`,
            media_type: "video/mp4",
            size: 9,
            hash: video.sha256 ?? undefined,
        },
        {
            url: `https://social.example/media/${kept?.sha256}`,
            media_type: "image/png",
            description: "A red square",
            size: kept?.size ?? undefined,
            hash: kept?.sha256 ?? undefined,
            thumbhash: kept?.thumbhash ?? undefined,
            width: 2,
            height: 2,
        },
        {
            url: `https://social.example/media/${file.sha256}`,
            media_type: "application/octet-stream",
            size: 8,
            hash: file.sha256 ?? undefined,
        },
    ]);
    assertEquals(v0_7.Note.safeParse(entity).success, true);
    assertEquals(kept?.thumbhash !== null && kept?.size !== null, true);

    // If one were no longer stored, the others would still be included.
    await test.ctx.db.updateTable("media").set({ sha256: null }).where("id", "=", file.id)
        .execute();
    assertEquals((await test.find(note.id, ""))?.attachments.length, 2);
});

Deno.test("a local note's files are where the store serves them, if it does", async () => {
    const files = { ...memoryFiles(), publicUrl: (key: string) => `https://cdn.example/${key}` };
    await using test = await open({ files });
    const file = await upload(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "application/zip",
    });
    const note = await postNote(test.ctx, "alice", {
        text: "",
        format: "text/plain",
        spoilerText: "",
        visibility: "public",
        mediaIds: [file.id],
    });
    if (note === undefined) throw new Error("Not posted");

    const entity = await test.find(note.id, "");

    assertEquals(entity?.attachments[0].url, `https://cdn.example/${file.sha256}`);
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

Deno.test("a note says its visibility as Versia's Social extension does", async () => {
    await using test = await open();
    const visibility = async (visibility: "public" | "unlisted" | "private" | "direct") => {
        const note = await createNote(test.ctx, "alice", { visibility }, ["erin"]);
        return (await test.find(note.id, "c.example"))?.visibility;
    };

    assertEquals(await visibility("public"), "public");
    assertEquals(await visibility("unlisted"), "unlisted");
    assertEquals(await visibility("private"), "subscribers");
    assertEquals(await visibility("direct"), "mentions");
});

Deno.test("a note says when it was edited, and its page", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    test.clock.advance(5000);
    await test.ctx.db.updateTable("notes").set({ edited_at: test.clock.now() })
        .where("id", "=", note.id).execute();

    const entity = await test.find(note.id, "");

    assertEquals(entity?.updated_at, test.clock.now().toISOString());
    assertEquals(entity?.url, `https://social.example/@alice/${note.id}`);
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

Deno.test("a note is shown on the instances of who it mentions, the followers, and who it replies to", async () => {
    await using test = await open();
    await createInstance(test.ctx, "d.example");
    await createRemoteAccount(test.ctx, "frank", "d.example");
    // Bob is local, and frank only requested to follow.
    await follow(test.ctx, "bob", "alice");
    await test.ctx.db.updateTable("accounts").set({ locked: true }).where("id", "=", "alice")
        .execute();
    await follow(test.ctx, "frank", "alice");
    const note = (visibility: Visibility, replyTo: string | null = "erin") => ({
        account_id: "alice",
        visibility,
        in_reply_to_account_id: replyTo,
    });

    // Its followers' instances are found when it is sent.
    const shownOn = async (shown: ReturnType<typeof note>, mentionIds: string[], quoted?: string) =>
        await audienceInstances(test.ctx, await audienceOf(test.ctx, shown, mentionIds, quoted));

    assertEquals(await shownOn(note("public"), []), ["b.example", "c.example"]);
    assertEquals(await shownOn(note("unlisted"), []), ["b.example", "c.example"]);
    assertEquals(await shownOn(note("private"), []), ["b.example", "c.example"]);
    assertEquals(await shownOn(note("private", null), []), ["b.example"]);
    assertEquals(await shownOn(note("direct"), []), ["c.example"]);
    assertEquals(await shownOn(note("direct", null), []), []);
    assertEquals(await shownOn(note("direct"), ["alice", "bob", "erin"]), [
        "c.example",
    ]);
    assertEquals(await shownOn(note("public", null), []), ["b.example"]);

    // The instance of the author of the status it quotes, shown the same way.
    assertEquals(await shownOn(note("public", null), [], "frank"), [
        "b.example",
        "d.example",
    ]);
    assertEquals(await shownOn(note("unlisted", "erin"), [], "frank"), [
        "b.example",
        "c.example",
        "d.example",
    ]);
    assertEquals(await shownOn(note("private", null), [], "frank"), ["b.example"]);
    assertEquals(await shownOn(note("direct", null), [], "frank"), []);
});

Deno.test("a user's Notes are their public and unlisted notes, oldest first", async () => {
    await using test = await open();
    const user = registry.types.get("User");
    const outbox: CollectionProvider | undefined = user?.collections?.["pub.versia:social/Notes"];
    if (outbox === undefined) throw new Error("Users have no Notes collection");

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
    assertEquals(
        (await outbox(test.ctx, "alice", { offset: 0, limit: 1 }, "b.example"))?.items[0],
        await test.find(ids[0], "b.example"),
    );
    assertEquals(await outbox(test.ctx, "carol", { offset: 0, limit: 40 }, "b.example"), undefined);
    assertEquals(
        await outbox(test.ctx, "nobody", { offset: 0, limit: 40 }, "b.example"),
        undefined,
    );
});

Deno.test("a user's Featured are references to the public and unlisted notes they pin, the latest first", async () => {
    await using test = await open();
    const featured: CollectionProvider | undefined = registry.types.get("User")?.collections
        ?.["pub.versia:social/Featured"];
    if (featured === undefined) throw new Error("Users have no featured notes");

    const ids = [];
    for (const visibility of ["public", "private", "unlisted", "public"] as const) {
        test.clock.advance(1);
        const note = await createNote(test.ctx, "alice", { visibility });
        await pin(test.ctx, "alice", note.id);
        ids.push(note.id);
    }

    await createNote(test.ctx, "alice");
    const page = async (offset: number, limit: number) => {
        const collection = await featured(test.ctx, "alice", { offset, limit }, "b.example");
        return collection;
    };
    const reference = (id: string) => `social.example:${id}`;

    assertEquals(await page(0, 2), {
        author: "alice",
        total: 3,
        items: [reference(ids[3]), reference(ids[2])],
    });
    assertEquals(await page(2, 2), { author: "alice", total: 3, items: [reference(ids[0])] });
    assertEquals(
        await featured(test.ctx, "carol", { offset: 0, limit: 40 }, "b.example"),
        undefined,
    );
    assertEquals(
        await featured(test.ctx, "nobody", { offset: 0, limit: 40 }, "b.example"),
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
        ["b.example", noteName, note?.id],
        ["c.example", noteName, note?.id],
        ["d.example", noteName, reply?.id],
    ]);

    const [[, entity]] = await queued(test.ctx);
    // As sent, without the omitted fields.
    assertEquals(entity, JSON.parse(JSON.stringify(await test.find(note?.id ?? "", ""))));
});

Deno.test("an edited note is sent again, whole, to those it is shown to now", async () => {
    await using test = await open();
    const note = await post(test.ctx, "alice", "Hi", "direct");
    if (note === undefined) throw new Error("Not posted");

    await editNote(test.ctx, "alice", note.id, { text: "Hi @erin@c.example" });
    await editNote(test.ctx, "alice", note.id, { text: "Hi @erin@c.example" });

    assertEquals(await sent(test.ctx), [["c.example", noteName, note.id]]);

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
    // Its own instance notifies the others that it is deleted, so Verso doesn't, even for erin.
    const remote = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "c1" },
        ["erin"],
    );

    for (const id of [note.id, direct.id, remote.id]) await removeNote(test.ctx, id);

    assertEquals(await sent(test.ctx), [
        ["b.example", "Delete", `social.example:${note.id}`],
        ["c.example", "Delete", `social.example:${note.id}`],
        ["d.example", "Delete", `social.example:${note.id}`],
    ]);

    const [[, entity]] = await queued(test.ctx);
    assertEquals(entity, {
        type: "Delete",
        created_at: test.clock.now().toISOString(),
        author: "social.example:alice",
        deleted_type: noteName,
        deleted: `social.example:${note.id}`,
    });
});

Deno.test("a followers-only note doesn't reach an instance where its author blocks every follower, unless it mentions one", async () => {
    await using test = await open();
    await follow(test.ctx, "erin", "alice");
    await block(test.ctx, "alice", "carol");

    const hidden = await post(test.ctx, "alice", "Hi", "private");
    const mentioning = await post(test.ctx, "alice", "Hi @carol@b.example", "private");
    const shown = await post(test.ctx, "alice", "Hi");
    await removeNote(test.ctx, hidden?.id ?? "");

    assertEquals((await sent(test.ctx)).toSorted(), [
        ["b.example", "Delete", `social.example:${hidden?.id}`],
        ["b.example", noteName, mentioning?.id],
        ["b.example", noteName, shown?.id],
        ["c.example", "Delete", `social.example:${hidden?.id}`],
        ["c.example", noteName, hidden?.id],
        ["c.example", noteName, mentioning?.id],
        ["c.example", noteName, shown?.id],
    ]);
    assertEquals(await test.find(hidden?.id ?? "", "b.example"), undefined);
    assertEquals((await test.find(mentioning?.id ?? "", "b.example"))?.id, mentioning?.id);

    // Another follower there brings it back.
    await createRemoteAccount(test.ctx, "dave", "b.example");
    await follow(test.ctx, "dave", "alice");
    const again = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals((await test.find(again.id, "b.example"))?.id, again.id);
});

Deno.test("a note that isn't public may be fetched by the instance of who it replies to", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "erin", {
        instance_id: "c.example",
        remote_id: "p1",
    });

    const reply = (visibility: Visibility, replyTo: string | null) =>
        createNote(test.ctx, "alice", {
            visibility,
            in_reply_to_id: replyTo === null ? null : parent.id,
            in_reply_to_account_id: replyTo,
        });
    const found = async (visibility: Visibility, replyTo: string | null) => {
        const note = await reply(visibility, replyTo);
        return (await test.find(note.id, "c.example"))?.id === note.id;
    };

    assertEquals(await found("private", "erin"), true);
    assertEquals(await found("direct", "erin"), true);
    assertEquals(await found("private", null), false);
    assertEquals(await found("direct", null), false);
    // Only the instance of who it replies to.
    const direct = await reply("direct", "erin");
    assertEquals(await test.find(direct.id, "b.example"), undefined);
});

Deno.test("a note reaches the instances of more followers than one query can name", async () => {
    await using test = await open();
    const instances = ["e0.example", "e1.example", "e2.example"];
    for (const domain of instances) await createInstance(test.ctx, domain);
    // More than the 65,535 values that Postgres allows one query to bind.
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
            items: [`${test.ctx.urls.domain}:${own.id}`, `b.example:c-${kind}`],
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
    assertEquals((await replies(note.id, "b.example"))?.items, [
        `${test.ctx.urls.domain}:${reply.id}`,
    ]);
    assertEquals(await replies(note.id, "c.example"), undefined);
    assertEquals(await replies("missing", "b.example"), undefined);
});

Deno.test("a note's collections are served to other instances", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    const url = new URL(
        `https://a.test/.versia/v0.7/entities/pub.versia:social/Note/${note.id}/collections/quotes`,
    );

    const reply = await fetchSigned(network.instances["b.test"].ctx, url);
    assertEquals([reply.status, JSON.parse(new TextDecoder().decode(reply.body))], [
        200,
        { total: 0, items: [] },
    ]);
});

Deno.test("a user's Notes and Featured are served to other instances", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    await pin(a, "alice", note.id);
    const url = (name: string) =>
        new URL(`https://a.test/.versia/v0.7/entities/User/alice/collections/${name}`);
    const fetch = async (name: string) => {
        const reply = await fetchSigned(network.instances["b.test"].ctx, url(name));
        return [reply.status, JSON.parse(new TextDecoder().decode(reply.body))];
    };

    const [status, collection] = await fetch("pub.versia:social/Notes");
    const [featuredStatus, featured] = await fetch("pub.versia:social/Featured");

    assertEquals([status, collection.total, collection.items[0].id], [200, 1, note.id]);
    assertEquals(v0_7.Note.safeParse(collection.items[0]).success, true);
    assertEquals([featuredStatus, featured], [200, { total: 1, items: [`a.test:${note.id}`] }]);
    assertEquals((await fetch("outbox"))[0], 404);
});
