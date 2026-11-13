import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { queuedDeliveries } from "../federation/testing.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import { share } from "../interactions/shares.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { attach } from "../media/attachments.ts";
import { findMedia } from "../media/media_queries.ts";
import { upload } from "../media/uploads.ts";
import { findNote } from "../notes/note_queries.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { subscribers } from "../services.ts";
import { createTestContext } from "../testing/context.ts";
import { removeStatus } from "./statuses.ts";

/**
 * alice and bob are local, carol is on b.example, and erin, who follows alice, on c.example.
 * `events` are what happened.
 */
const open = async () => {
    const events: DomainEvent[] = [];
    const test = await createTestContext({
        subscribers: [...subscribers, (_, event) => Promise.resolve(void events.push(event))],
    });

    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    for (const [id, domain] of [["carol", "b.example"], ["erin", "c.example"]]) {
        await createInstance(test.ctx, domain);
        await createRemoteAccount(test.ctx, id, domain);
    }

    await follow(test.ctx, "erin", "alice");

    return Object.assign(test, { events });
};

/** The Deletes queued to be sent, as the instance each is for and what it deletes. */
const deletes = async (ctx: Context) =>
    (await queuedDeliveries(ctx))
        .map((job) => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === "Delete")
        .map(([domain, entity]) => [domain, entity.deleted_type, entity.deleted]);

Deno.test("a local status is deleted with its media, and other instances are told", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const { id: mediaId } = await upload(test.ctx, "alice", {
        file: new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]),
        mediaType: "application/zip",
    });
    await attach(test.ctx, "alice", note.id, [mediaId]);

    assertEquals(await removeStatus(test.ctx, note.id), true);

    assertEquals(await findNote(test.ctx, note.id), undefined);
    assertEquals(await findMedia(test.ctx, mediaId), undefined);
    assertEquals(await deletes(test.ctx), [["c.example", "Note", note.id]]);
    assertEquals(await removeStatus(test.ctx, note.id), false);
});

Deno.test("a remote status is deleted here only, with its boosts", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" });
    const shared = await share(test.ctx, "bob", note.id);
    if (typeof shared === "string") throw new Error(`The note was ${shared}`);

    assertEquals(await removeStatus(test.ctx, note.id), true);

    assertEquals(await findNote(test.ctx, note.id), undefined);
    assertEquals(await findNote(test.ctx, shared.id), undefined);
    assertEquals(await deletes(test.ctx), []);
});

Deno.test("a local boost is undone, so other instances are told of a Share", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "carol", { instance_id: "b.example", remote_id: "n1" });
    const shared = await share(test.ctx, "alice", note.id);
    if (typeof shared === "string") throw new Error(`The note was ${shared}`);

    assertEquals(await removeStatus(test.ctx, shared.id), true);

    assertEquals(await findNote(test.ctx, shared.id), undefined);
    assertEquals((await findNote(test.ctx, note.id))?.shares_count, 0);
    assertEquals(await deletes(test.ctx), [
        ["b.example", "pub.versia:share/Share", shared.id],
        ["c.example", "pub.versia:share/Share", shared.id],
    ]);
});

Deno.test("a remote boost is deleted here only, and the status it boosts stays", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const shared = await createShare(test.ctx, "carol", note.id, {
        instance_id: "b.example",
        remote_id: "s1",
    });

    test.events.length = 0;

    assertEquals(await removeStatus(test.ctx, shared.id), true);

    assertEquals(await findNote(test.ctx, shared.id), undefined);
    assertEquals((await findNote(test.ctx, note.id))?.id, note.id);
    // Like when its instance deletes it, not like a local user undoing it.
    assertEquals(test.events.map((event) => event.type), ["notes.deleted"]);
    assertEquals(await deletes(test.ctx), []);
});
