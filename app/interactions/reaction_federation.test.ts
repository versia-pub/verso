import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import { fetchSigned } from "../federation/request.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { createNetwork } from "../testing/network.ts";
import { findLocalReaction } from "./reaction_queries.ts";
import { reactionType } from "./reaction_federation.ts";
import { react, unreact } from "./reactions.ts";

/**
 * alice and bob are local, with the local instance's blob, carol is on b.example, erin on
 * c.example, who follows alice, and frank on d.example.
 */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const remote = [["carol", "b.example"], ["erin", "c.example"], ["frank", "d.example"]];
    for (const [id, domain] of remote) {
        await createInstance(test.ctx, domain);
        await createRemoteAccount(test.ctx, id, domain);
    }
    await follow(test.ctx, "erin", "alice");
    await createLocalEmoji(test.ctx, "blob");

    const find = (id: string, requester: string) => {
        if (reactionType.find === undefined) throw new Error("Reactions can't be fetched");
        return reactionType.find(test.ctx, id, requester);
    };

    /** A page of a local status's reactions, as `requester` may see them. */
    const reactions = (id: string, requester: string, page = { offset: 0, limit: 40 }) =>
        registry.types.get("Note")?.collections?.["pub.versia:reactions/Reactions"]?.(
            test.ctx,
            id,
            page,
            requester,
        );

    /** Reacts for `accountId`, and returns the id of the reaction. */
    const reacted = async (accountId: string, noteId: string, name: string) => {
        await react(test.ctx, accountId, noteId, name);
        const row = await test.ctx.db.selectFrom("reactions").select("id")
            .orderBy("id", "desc")
            .executeTakeFirstOrThrow();
        return row.id;
    };

    return { ...test, find, reactions, reacted };
};

/** The reactions and Deletes queued to be sent, with the instance each is for. */
const sent = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type !== "FollowAccept");

Deno.test("a reaction is sent to the note's author and the reactor's followers, and a Delete when undone", async () => {
    await using test = await open();
    const theirs = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "n1",
    });
    const local = await createNote(test.ctx, "bob");

    const blob = await test.reacted("alice", theirs.id, ":blob:");
    const reactedAt = test.ctx.clock.now().toISOString();
    const party = await test.reacted("alice", local.id, "🎉");
    test.clock.advance(1000);
    await unreact(test.ctx, "alice", theirs.id, ":blob:");

    const now = test.ctx.clock.now().toISOString();
    assertEquals(
        (await sent(test.ctx)).map(([domain, each]) => [domain, each.id ?? each.deleted]),
        [
            ["b.example", blob],
            ["c.example", blob],
            ["c.example", party],
            ["b.example", blob],
            ["c.example", blob],
        ],
    );
    assertEquals((await sent(test.ctx))[0][1], {
        type: "pub.versia:reactions/Reaction",
        id: blob,
        created_at: reactedAt,
        author: "alice",
        object: "b.example:n1",
        content: ":blob:",
        extensions: {
            "pub.versia:custom_emojis": {
                emojis: [{
                    name: ":blob:",
                    content: {
                        "image/png": { content: "https://pictures.example/blob.png", remote: true },
                    },
                }],
            },
        },
    });
    assertEquals((await sent(test.ctx))[2][1].content, "🎉");
    assertEquals((await sent(test.ctx))[2][1].extensions, undefined);
    assertEquals((await sent(test.ctx))[3][1], {
        type: "Delete",
        created_at: now,
        author: "alice",
        deleted_type: "pub.versia:reactions/Reaction",
        deleted: blob,
    });
});

Deno.test("a reaction to a note not everyone may see is only sent to its author's instance", async () => {
    await using test = await open();
    const theirs = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "n1", visibility: "direct" },
        ["alice"],
    );
    const local = await createNote(test.ctx, "alice", { visibility: "private" });

    const reaction = await test.reacted("alice", theirs.id, "🎉");
    await test.reacted("alice", local.id, "🎉");

    assertEquals((await sent(test.ctx)).map(([domain, each]) => [domain, each.id]), [
        ["b.example", reaction],
    ]);
});

Deno.test("a local reaction is fetched by instances that may see its note, or whose note it is", async () => {
    await using test = await open();
    const theirs = await createNote(
        test.ctx,
        "carol",
        { instance_id: "b.example", remote_id: "n1", visibility: "direct" },
        ["alice"],
    );
    const local = await createNote(test.ctx, "alice", { visibility: "private" });
    const hidden = await test.reacted("alice", theirs.id, "🎉");
    const followed = await test.reacted("alice", local.id, ":blob:");

    assertEquals((await test.find(hidden, "b.example"))?.object, "b.example:n1");
    assertEquals(await test.find(hidden, "c.example"), undefined);
    const madeAt = test.ctx.clock.now().toISOString();
    test.clock.advance(1000);
    assertEquals((await test.find(followed, "c.example"))?.content, ":blob:");
    assertEquals((await test.find(followed, "c.example"))?.created_at, madeAt);
    assertEquals(await test.find(followed, "d.example"), undefined);

    // Neither a remote instance's reaction, nor a status, is fetched as a reaction.
    await test.ctx.db.insertInto("reactions")
        .values({
            id: "r1",
            account_id: "carol",
            note_id: local.id,
            text: "🎉",
            emoji_id: null,
            instance_id: "b.example",
            remote_id: "r1",
            created_at: test.ctx.clock.now(),
        })
        .execute();
    assertEquals(await findLocalReaction(test.ctx, "r1"), undefined);
    assertEquals(await test.find("r1", "b.example"), undefined);
    assertEquals(await test.find(local.id, "c.example"), undefined);
});

Deno.test("a local note lists its reactions, for instances that may see it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob");
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    const first = await test.reacted("alice", note.id, "🎉");
    const second = await test.reacted("bob", note.id, ":blob:");
    await test.reacted("alice", hidden.id, "🎉");
    const theirs = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "n1",
    });
    await test.reacted("alice", theirs.id, "🎉");
    const share = await createShare(test.ctx, "alice", note.id);

    assertEquals(await test.reactions(note.id, "d.example"), {
        author: "bob",
        total: 2,
        items: [first, second],
    });
    assertEquals(await test.reactions(note.id, "d.example", { offset: 1, limit: 1 }), {
        author: "bob",
        total: 2,
        items: [second],
    });
    assertEquals((await test.reactions(hidden.id, "c.example"))?.total, 1);
    assertEquals(await test.reactions(hidden.id, "d.example"), undefined);
    assertEquals(await test.reactions(first, "d.example"), undefined);
    // Remote instances list the reactions of their own statuses, and boosts have none.
    assertEquals(await test.reactions(theirs.id, "b.example"), undefined);
    assertEquals(await test.reactions(share.id, "d.example"), undefined);
});

Deno.test("reactions and their collection are served at encoded URLs", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    await react(a, "alice", note.id, "🎉");
    const { id } = await a.db.selectFrom("reactions").select("id").executeTakeFirstOrThrow();
    const read = async (url: URL) => {
        const reply = await fetchSigned(b, url);
        return [reply.status, JSON.parse(new TextDecoder().decode(reply.body))];
    };

    const [status, entity] = await read(entityUrl("a.test", "pub.versia:reactions/Reaction", id));
    assertEquals([status, entity.content], [200, "🎉"]);

    const collection = new URL(
        `${entityUrl("a.test", "Note", note.id)}/collections/${
            encodeURIComponent("pub.versia:reactions/Reactions")
        }`,
    );
    assertEquals(await read(collection), [200, { author: "alice", total: 1, items: [id] }]);
});

Deno.test("Verso says it supports reactions", () => {
    assertEquals(registry.extensions.includes("pub.versia:reactions"), true);
});
