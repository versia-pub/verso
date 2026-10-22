import { assertEquals } from "@std/assert";
import { findAccount } from "../accounts/account_queries.ts";
import { deleteRemoteAccount } from "../accounts/remote.ts";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { follow, followedSubquery } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { findNote, notePageBy } from "./note_queries.ts";
import { removeNote } from "./notes.ts";
import { knownNote } from "./remote.ts";
import { createNote, createShare } from "./testing.ts";
import { homePage, publicPage } from "./timeline_queries.ts";

/** alice and bob here, who follows alice, and carol on b.example. */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await follow(test.ctx, "bob", "alice");

    /** How many statuses an account has, and how many shares a note has. */
    const counts = async (accountId: string, noteId: string) => [
        (await findAccount(test.ctx, accountId))?.statuses_count,
        (await findNote(test.ctx, noteId))?.shares_count,
    ];

    return { ...test, counts };
};

Deno.test("a share is counted as its author's status, and as a share of what it shares", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" });

    const share = await createShare(test.ctx, "alice", note.id);
    assertEquals(await test.counts("alice", note.id), [1, 1]);

    await removeNote(test.ctx, share.id);
    assertEquals(await test.counts("alice", note.id), [0, 0]);
});

Deno.test("a note deleted takes its shares with it, uncounted", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" });
    const share = await createShare(test.ctx, "alice", note.id);
    await createShare(test.ctx, "bob", note.id, { visibility: "direct" });
    await createNote(test.ctx, "bob");

    await removeNote(test.ctx, note.id);

    assertEquals(await findNote(test.ctx, share.id), undefined);
    assertEquals((await findAccount(test.ctx, "alice"))?.statuses_count, 0);
    // The direct share wasn't counted, so it isn't uncounted; bob's own note still is.
    assertEquals((await findAccount(test.ctx, "bob"))?.statuses_count, 1);
});

Deno.test("an account deleted takes its shares and the shares of its notes, uncounted", async () => {
    await using test = await open();
    const theirs = [
        await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" }),
        await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n2" }),
    ];
    const local = await createNote(test.ctx, "alice");
    for (const note of theirs) await createShare(test.ctx, "alice", note.id);
    await createShare(test.ctx, "bob", theirs[0].id);
    // Not counted, so not uncounted.
    await createShare(test.ctx, "bob", theirs[1].id, { visibility: "direct" });
    await createShare(test.ctx, "carol", local.id, { instance_id: "b.example", remote_id: "s1" });
    await createShare(test.ctx, "bob", local.id);

    await deleteRemoteAccount(test.ctx, "b.example", "carol");

    // alice keeps her own note, and bob his share of it.
    assertEquals(await test.counts("alice", local.id), [1, 1]);
    assertEquals((await findAccount(test.ctx, "bob"))?.statuses_count, 1);
});

Deno.test("shares aren't shown or sent as notes yet", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const share = await createShare(test.ctx, "alice", note.id);
    const page = { limit: 40 };
    const ids = (notes: readonly { id: string }[]) => notes.map((each) => each.id);

    assertEquals(ids(await homePage(test.ctx, "bob", followedSubquery(test.ctx, "bob"), page)), [
        note.id,
    ]);
    assertEquals(ids(await publicPage(test.ctx, "all", page)), [note.id]);
    assertEquals(ids(await notePageBy(test.ctx, "alice", ["public"], {}, page)), [note.id]);

    const noteType = registry.types.get("Note");
    assertEquals(await noteType?.find?.(test.ctx, share.id, "b.example"), undefined);
    assertEquals(
        await knownNote(test.ctx, { host: test.ctx.urls.domain, id: share.id }),
        undefined,
    );

    const outbox = registry.types.get("User")?.collections?.outbox;
    const sent = await outbox?.(test.ctx, "alice", { offset: 0, limit: 40 }, "b.example");
    assertEquals([sent?.total, sent?.items.length], [1, 1]);
});
