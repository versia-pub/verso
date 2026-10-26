import { assertEquals, assertExists } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import { fetchSigned } from "../federation/request.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { createNote } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { findLike } from "./like_queries.ts";
import { keepRemoteLike, like, unlike } from "./likes.ts";

/** alice and bob are local, and carol is on b.example and erin on c.example, who follow no one. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    for (const [id, domain] of [["carol", "b.example"], ["erin", "c.example"]]) {
        await createInstance(test.ctx, domain);
        await createRemoteAccount(test.ctx, id, domain);
    }

    const type = (name: string) => {
        const found = registry.types.get(name);
        if (found === undefined) throw new Error(`${name} isn't registered`);
        return found;
    };

    /** A page of a local entity's collection, as `requester` may see it. */
    const collection = (entity: "User" | "Note", name: string, id: string, requester: string) => {
        const provider = type(entity).collections?.[name];
        return provider?.(test.ctx, id, { offset: 0, limit: 40 }, requester);
    };

    return { ...test, type, collection };
};

/** The likes and Deletes queued to be sent, with the instance each is for. */
const sent = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job) => [job.domain, JSON.parse(job.body)]);

Deno.test("a like of another instance's note is sent there, and a Delete when undone", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" });
    const local = await createNote(test.ctx, "alice");

    await like(test.ctx, "alice", note.id);
    await like(test.ctx, "bob", local.id);
    const row = await findLike(test.ctx, "alice", note.id);
    await unlike(test.ctx, "alice", note.id);

    const now = test.ctx.clock.now().toISOString();
    assertEquals(await sent(test.ctx), [
        ["b.example", {
            type: "pub.versia:likes/Like",
            id: row?.id,
            created_at: now,
            author: "alice",
            liked: "b.example:n1",
        }],
        ["b.example", {
            type: "Delete",
            created_at: now,
            author: "alice",
            deleted_type: "pub.versia:likes/Like",
            deleted: row?.id,
        }],
    ]);
});

Deno.test("a local like is fetched by instances that may see its note, or whose note it is", async () => {
    await using test = await open();
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });
    // A status only for alice, which c.example may not see.
    const theirs = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "n1", visibility: "direct" },
        ["alice"],
    );
    await follow(test.ctx, "alice", "bob");
    for (const note of [hidden, theirs]) await like(test.ctx, "alice", note.id);
    const find = (noteId: string, requester: string) =>
        findLike(test.ctx, "alice", noteId).then((row) =>
            test.type("pub.versia:likes/Like").find?.(test.ctx, row?.id ?? "", requester)
        );

    assertEquals(await find(hidden.id, "b.example"), undefined);
    assertEquals((await find(theirs.id, "b.example") as { liked?: string })?.liked, "b.example:n1");
    assertEquals(await find(theirs.id, "c.example"), undefined);
    assertEquals(
        await test.type("pub.versia:likes/Like").find?.(test.ctx, "missing", "b.example"),
        undefined,
    );
});

Deno.test("a local note lists its likes and dislikes, for instances that may see it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    await like(test.ctx, "bob", note.id);
    const remote = (accountId: string, kind: "like" | "dislike", remoteId: string) =>
        keepRemoteLike(test.ctx, {
            accountId,
            noteId: note.id,
            kind,
            instanceId: accountId === "carol" ? "b.example" : "c.example",
            remoteId,
            createdAt: test.ctx.clock.now(),
        });
    await remote("carol", "like", "l1");
    await remote("erin", "dislike", "d1");
    const bob = await findLike(test.ctx, "bob", note.id);
    assertExists(bob);

    assertEquals(await test.collection("Note", "pub.versia:likes/Likes", note.id, "c.example"), {
        author: "alice",
        total: 2,
        items: [bob.id, "b.example:l1"],
    });
    assertEquals(await test.collection("Note", "pub.versia:likes/Dislikes", note.id, "b.example"), {
        author: "alice",
        total: 1,
        items: ["c.example:d1"],
    });
    assertEquals(
        await test.collection("Note", "pub.versia:likes/Likes", hidden.id, "b.example"),
        undefined,
    );
});

Deno.test("a local user lists the public and unlisted notes they like", async () => {
    await using test = await open();
    const notes = [
        await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" }),
        await createNote(test.ctx, "bob", { visibility: "unlisted" }),
        await createNote(test.ctx, "bob", { visibility: "private" }),
    ];
    await follow(test.ctx, "alice", "bob");
    for (const note of notes) await like(test.ctx, "alice", note.id);

    assertEquals(await test.collection("User", "pub.versia:likes/Likes", "alice", "c.example"), {
        author: "alice",
        total: 2,
        items: ["b.example:n1", notes[1].id],
    });
    assertEquals(
        await test.collection("User", "pub.versia:likes/Dislikes", "alice", "c.example"),
        { author: "alice", total: 0, items: [] },
    );
    assertEquals(
        await test.collection("User", "pub.versia:likes/Likes", "carol", "c.example"),
        undefined,
    );
});

Deno.test("likes and their collections are served at encoded URLs", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    await like(a, "alice", note.id);
    const row = await findLike(a, "alice", note.id);
    const read = async (url: URL) => {
        const reply = await fetchSigned(b, url);
        return [reply.status, JSON.parse(new TextDecoder().decode(reply.body))];
    };

    assertEquals(
        new URL(entityUrl("a.test", "pub.versia:likes/Like", row?.id ?? "")).pathname,
        `/.versia/v0.6/entities/pub.versia%3Alikes%2FLike/${row?.id}`,
    );
    const [status, entity] = await read(
        entityUrl("a.test", "pub.versia:likes/Like", row?.id ?? ""),
    );
    assertEquals([status, entity.liked], [200, note.id]);

    const collection = new URL(
        `${entityUrl("a.test", "Note", note.id)}/collections/${
            encodeURIComponent("pub.versia:likes/Likes")
        }`,
    );
    assertEquals(await read(collection), [200, { author: "alice", total: 1, items: [row?.id] }]);
});
