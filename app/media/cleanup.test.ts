import { assertEquals, assertRejects } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { schedule } from "../jobs/scheduler.ts";
import { drain } from "../jobs/worker.ts";
import { postNote, removeNote } from "../notes/notes.ts";
import { createTestContext } from "../testing/context.ts";
import { createInstance } from "../instances/testing.ts";
import { findMedia, saveRemoteMedia } from "./media.ts";
import { removeUnusedUploads, upload } from "./uploads.ts";

const hour = 60 * 60 * 1000;

const zip = (n: number) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, n]);

const png = new Uint8Array(encode({
    width: 2,
    height: 2,
    data: new Uint8Array(16).fill(200),
    channels: 4,
}));

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");

    /** The id of a file alice uploads. */
    const uploaded = async (bytes: Uint8Array<ArrayBuffer>) =>
        (await upload(test.ctx, "alice", { bytes, mediaType: "application/zip" })).id;

    /** Whether a file is kept under `key`. */
    const kept = async (key: string | null) => {
        if (key === null) return false;

        const stream = await test.ctx.files.get(key);
        await stream?.cancel();
        return stream !== undefined;
    };

    /** Runs the recurring jobs, as the scheduler would, after `ms` pass. */
    const later = async (ms: number) => {
        test.clock.advance(ms);
        await schedule(test.ctx, tasks);
        await drain(test.ctx, queues);
    };

    const post = async (mediaIds: string[]) => {
        const note = await postNote(test.ctx, "alice", {
            text: "Hi",
            format: "text/plain",
            spoilerText: "",
            mediaIds,
        });
        if (note === undefined) throw new Error("Not posted");
        return note.id;
    };

    return { ...test, uploaded, kept, later, post };
};

Deno.test("uploads no one attached are removed a day on, with files no others use", async () => {
    await using test = await open();
    const notes = await test.uploaded(zip(1));
    const picture = await test.uploaded(png);
    await drain(test.ctx, queues);
    const attached = await test.uploaded(zip(2));
    await test.post([attached]);
    const processed = await findMedia(test.ctx, picture);
    test.clock.advance(12 * hour);
    const again = await test.uploaded(zip(1));
    const key = (await findMedia(test.ctx, notes))?.sha256 ?? null;

    await test.later(12 * hour - 1);
    assertEquals((await findMedia(test.ctx, notes))?.id, notes);

    await test.later(1);
    assertEquals(await findMedia(test.ctx, notes), undefined);
    assertEquals(await findMedia(test.ctx, picture), undefined);
    assertEquals(
        await Promise.all(
            [processed?.sha256, processed?.preview_sha256, processed?.upload_sha256]
                .map((each) => test.kept(each ?? null)),
        ),
        [false, false, false],
    );
    assertEquals((await findMedia(test.ctx, attached))?.id, attached);
    // The same file, uploaded since, keeps it.
    assertEquals([(await findMedia(test.ctx, again))?.id, await test.kept(key)], [again, true]);

    await test.later(12 * hour);
    assertEquals([await findMedia(test.ctx, again), await test.kept(key)], [undefined, false]);
});

Deno.test("a deleted note's files can be attached again, until they are removed", async () => {
    await using test = await open();
    const file = await test.uploaded(zip(1));
    await removeNote(test.ctx, await test.post([file]));
    await test.later(hour);

    const redrafted = await test.post([file]);
    await removeNote(test.ctx, redrafted);
    await test.later(24 * hour);

    assertEquals(await findMedia(test.ctx, file), undefined);
});

Deno.test("only uploads are removed, not files an account or an emoji shows", async () => {
    await using test = await open();
    const [avatar, header] = [await test.uploaded(zip(1)), await test.uploaded(zip(2))];
    await test.ctx.db.updateTable("accounts").set({ avatar_id: avatar, header_id: header })
        .execute();
    await createLocalEmoji(test.ctx, "blob");
    await test.ctx.db.updateTable("media").set({ account_id: "alice" }).execute();
    await createLocalEmoji(test.ctx, "other");
    await createInstance(test.ctx, "b.example");
    await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/bob.png",
        mediaType: "image/png",
    });
    const unused = await test.uploaded(zip(3));

    await test.later(24 * hour);

    const left = await test.ctx.db.selectFrom("media").select("id").execute();
    assertEquals([left.length, left.some((row) => row.id === unused)], [5, false]);
});

Deno.test("any number of uploads are removed, a number of batches a run", async () => {
    await using test = await open();
    for (let n = 0; n < 201; n++) await test.uploaded(zip(n));
    test.clock.advance(24 * hour);

    await removeUnusedUploads(test.ctx, 2);
    assertEquals((await test.ctx.db.selectFrom("media").select("id").execute()).length, 1);

    await test.later(0);
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
});

Deno.test("what was uploaded of a picture is removed with it, if a run left it", async () => {
    await using test = await open();
    const picture = await test.uploaded(png);
    await drain(test.ctx, queues);
    // As if processing stopped before removing what was uploaded.
    const left = await test.ctx.files.put(png, "image/png");

    await test.later(24 * hour);

    assertEquals([await findMedia(test.ctx, picture), await test.kept(left)], [undefined, false]);
});

Deno.test("a file attached to a note can't be deleted", async () => {
    await using test = await open();
    const file = await test.uploaded(zip(1));
    await test.post([file]);

    await assertRejects(() => test.ctx.db.deleteFrom("media").where("id", "=", file).execute());
});
