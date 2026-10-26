import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
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
import { shareType } from "./share_federation.ts";
import { share, unshare } from "./shares.ts";

/**
 * alice and bob are local, carol is on b.example, erin on c.example, who follows alice, and frank
 * on d.example.
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

    const find = (id: string, requester: string) => {
        if (shareType.find === undefined) throw new Error("Shares can't be fetched");
        return shareType.find(test.ctx, id, requester);
    };

    /** A page of a local status's boosts, as `requester` may see them. */
    const shares = (id: string, requester: string, page = { offset: 0, limit: 40 }) =>
        registry.types.get("Note")?.collections?.["pub.versia:share/Shares"]?.(
            test.ctx,
            id,
            page,
            requester,
        );

    return { ...test, find, shares };
};

/** The Shares and Deletes queued to be sent, with the instance each is for. */
const sent = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type !== "FollowAccept");

Deno.test("a share is sent to the sharer's followers and the note's author, and a Delete when undone", async () => {
    await using test = await open();
    const theirs = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "n1",
    });
    const local = await createNote(test.ctx, "bob");

    const shared = await share(test.ctx, "alice", theirs.id, "private");
    await share(test.ctx, "alice", local.id);
    await unshare(test.ctx, "alice", theirs.id);
    if (typeof shared === "string") throw new Error(`The note was ${shared}`);

    const now = test.ctx.clock.now().toISOString();
    const entity = {
        type: "pub.versia:share/Share",
        id: shared.id,
        created_at: now,
        author: "alice",
        shared: "b.example:n1",
    };
    const deleted = {
        type: "Delete",
        created_at: now,
        author: "alice",
        deleted_type: "pub.versia:share/Share",
        deleted: shared.id,
    };
    const sentFor = (await sent(test.ctx)).map((
        [domain, each],
    ) => [domain, each.shared ?? each.deleted]);
    assertEquals(sentFor, [
        ["b.example", "b.example:n1"],
        ["c.example", "b.example:n1"],
        ["c.example", local.id],
        ["b.example", shared.id],
        ["c.example", shared.id],
    ]);
    assertEquals((await sent(test.ctx))[0][1], entity);
    assertEquals((await sent(test.ctx))[3][1], deleted);
});

Deno.test("a local share is fetched by instances that may see it, or whose note it shares", async () => {
    await using test = await open();
    const theirs = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "n1",
    });
    const local = await createNote(test.ctx, "bob");
    const hidden = await createShare(test.ctx, "alice", theirs.id, { visibility: "private" });
    const seen = await createShare(test.ctx, "alice", local.id);
    const remote = await createShare(test.ctx, "carol", local.id, {
        instance_id: "b.example",
        remote_id: "s1",
    });

    assertEquals((await test.find(hidden.id, "b.example"))?.shared, "b.example:n1");
    assertEquals((await test.find(hidden.id, "c.example"))?.shared, "b.example:n1");
    assertEquals(await test.find(hidden.id, "d.example"), undefined);
    assertEquals(await test.find(seen.id, "d.example"), {
        type: "pub.versia:share/Share",
        id: seen.id,
        created_at: seen.created_at.toISOString(),
        author: "alice",
        shared: local.id,
    });

    // Neither remote instances' Shares, nor Notes, are fetched as Shares.
    assertEquals(await test.find(remote.id, "b.example"), undefined);
    assertEquals(await test.find(local.id, "b.example"), undefined);
});

Deno.test("a local note lists its public and unlisted shares, for instances that may see it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob");
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });
    const alice = await createShare(test.ctx, "alice", note.id, { visibility: "unlisted" });
    await createShare(test.ctx, "bob", note.id, { visibility: "private" });
    await createShare(test.ctx, "carol", note.id, { instance_id: "b.example", remote_id: "s1" });
    await createShare(test.ctx, "alice", hidden.id);

    assertEquals(await test.shares(note.id, "d.example"), {
        author: "bob",
        total: 2,
        items: [alice.id, "b.example:s1"],
    });
    assertEquals(await test.shares(note.id, "d.example", { offset: 1, limit: 1 }), {
        author: "bob",
        total: 2,
        items: ["b.example:s1"],
    });
    assertEquals(await test.shares(hidden.id, "d.example"), undefined);
    assertEquals(await test.shares(alice.id, "d.example"), undefined);
});

Deno.test("shares and their collection are served at encoded URLs", async () => {
    await using network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    await createLocalAccount(a, "alice");
    const note = await createNote(a, "alice");
    const shared = await createShare(a, "alice", note.id);
    const read = async (url: URL) => {
        const reply = await fetchSigned(b, url);
        return [reply.status, JSON.parse(new TextDecoder().decode(reply.body))];
    };

    const [status, entity] = await read(entityUrl("a.test", "pub.versia:share/Share", shared.id));
    assertEquals([status, entity.shared], [200, note.id]);

    const collection = new URL(
        `${entityUrl("a.test", "Note", note.id)}/collections/${
            encodeURIComponent("pub.versia:share/Shares")
        }`,
    );
    assertEquals(await read(collection), [200, { author: "alice", total: 1, items: [shared.id] }]);
});
