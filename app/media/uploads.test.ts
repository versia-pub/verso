import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { fakeClock } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { bytesSource, type FileStore, memoryFiles } from "../kernel/files.ts";
import type { ImageProcessor } from "../kernel/images.ts";
import { s3Files } from "../kernel/s3_files.ts";
import { vipsImages } from "../kernel/vips_images.ts";
import { fakeBucket, fakeS3 } from "../testing/fake_s3.ts";
import { createTestContext, type TestContextOptions } from "../testing/context.ts";
import { createInstance } from "../instances/testing.ts";
import { isMediaProcessed } from "./events.ts";
import { findMedia, saveRemoteMedia } from "./media_queries.ts";
import { finishUpload } from "./upload_queries.ts";
import {
    deleteFileIfUnused,
    mediaQueue,
    processingFailed,
    upload,
    uploadPicture,
} from "./uploads.ts";

/** A `width`×`height` PNG, entirely red. */
const png = (width: number, height: number) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).map((_, i) => [200, 30, 30, 255][i % 4]),
        channels: 4,
    }));

/**
 * A 3×2 JPEG, taken by a camera held on its side, with the location where it was taken in its EXIF.
 */
const sidewaysJpeg = Uint8Array.fromBase64(
    "/9j/4QB8RXhpZgAATU0AKgAAAAgAAwESAAMAAAABAAYAAAITAAMAAAABAAEAAIglAAQAAAABAAAAMgAAAAAAAwAAAAEAAAAE" +
        "AgMAAAABAAIAAAACTgAAAAACAAUAAAADAAAAXAAAAAAAAAAwAAAAAQAAADMAAAABAAAAAAAAAAH/2wBDABALDA4MChAO" +
        "DQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8a" +
        "Gi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAMDASIA" +
        "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
        "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZn" +
        "aGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl" +
        "5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3" +
        "AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RV" +
        "VldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU" +
        "1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiqKKKAP/Z",
);

const vips = vipsImages({ maxPixels: 8_294_400 });

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const open = async (options: TestContextOptions = {}) => {
    const test = await createTestContext(options);
    await createLocalAccount(test.ctx, "alice");

    /** The file stored under `key`, or `undefined` if there is none. */
    const file = async (key: string | null) => {
        const stream = key === null ? undefined : await test.ctx.files.get(key);
        return stream && await new Response(stream).bytes();
    };

    const jobs = () =>
        test.ctx.db.selectFrom("jobs").select(["queue", "attempts", "finished_at"])
            .where("queue", "=", mediaQueue)
            .execute();

    return { ...test, file, jobs };
};

/** Whether `bytes` contain EXIF metadata, as a JPEG stores it. */
const hasExif = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes).includes("Exif\0\0");

const sha256Of = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

Deno.test("a file that isn't a picture is kept as it is, ready at once", async () => {
    await using test = await open();

    const row = await upload(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "Application/Zip",
        description: "My notes",
    });

    assertEquals(await findMedia(test.ctx, row.id), row);
    assertEquals(row.account_id, "alice");
    assertEquals(row.media_type, "application/zip");
    assertEquals(row.size, zip.length);
    assertEquals(row.sha256, await sha256Of(zip));
    assertEquals(row.upload_sha256, row.sha256);
    assertEquals(row.processed_at, test.clock.now());
    assertEquals(row.description, "My notes");
    assertEquals(await test.file(row.sha256), zip);
    assertEquals(await test.jobs(), []);
});

Deno.test("a file's type is the client's only if it is written as one", async () => {
    await using test = await open();

    const row = await upload(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "a zip, I think",
    });

    assertEquals(row.media_type, "application/octet-stream");
});

Deno.test("a file is kept with a type from its bytes, so it can't be served as a page", async () => {
    const s3 = fakeS3();
    const files = s3Files(fakeBucket, fakeTransport({ "s3.test": s3 }), fakeClock());
    await using test = await open({ files });
    const page = new TextEncoder().encode("<script>alert(1)</script>");

    const html = await upload(test.ctx, "alice", {
        file: new Blob([page]),
        mediaType: "text/html",
    });
    const picture = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "text/html",
    });

    assertEquals(html.media_type, "text/html");
    assertEquals(s3.objects.get(html.sha256 ?? "")?.type, "application/octet-stream");
    assertEquals(picture.media_type, "image/png");
    assertEquals(s3.objects.get(picture.sha256 ?? "")?.type, "image/png");
});

Deno.test("video and audio are kept with the type their client says, so they can be played", async () => {
    const s3 = fakeS3();
    const files = s3Files(fakeBucket, fakeTransport({ "s3.test": s3 }), fakeClock());
    await using test = await open({ files });

    for (const type of ["video/mp4", "audio/ogg"]) {
        const row = await upload(test.ctx, "alice", {
            file: new Blob([zip, new TextEncoder().encode(type)]),
            mediaType: type,
        });

        assertEquals(row.media_type, type);
        assertEquals(s3.objects.get(row.sha256 ?? "")?.type, type);
    }
});

Deno.test("a picture is processed by a job, which keeps it without its metadata", async () => {
    await using test = await open();

    const row = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
        focus: { x: 0.5, y: -0.25 },
    });

    assertEquals(row.processed_at, null);
    assertEquals(row.media_type, "image/jpeg");
    assertEquals([row.focus_x, row.focus_y], [0.5, -0.25]);
    assertEquals(await test.jobs(), [{ queue: mediaQueue, attempts: 0, finished_at: null }]);

    await drain(test.ctx, queues);

    const processed = await findMedia(test.ctx, row.id);
    assert(processed);
    assertEquals(processed.processed_at, test.clock.now());
    assertEquals(processed.upload_sha256, row.upload_sha256);
    assertNotEquals(processed.sha256, row.upload_sha256);
    assertEquals([processed.width, processed.height], [2, 3]);
    assertEquals([processed.preview_width, processed.preview_height], [2, 3]);
    assertEquals(processed.media_type, "image/jpeg");
    assert(processed.thumbhash && processed.blurhash);
    assertEquals([processed.focus_x, processed.focus_y], [0.5, -0.25]);

    const kept = await test.file(processed.sha256);
    assert(kept && !hasExif(kept));
    assertEquals(processed.size, kept.length);
    assertEquals(processed.sha256, await sha256Of(kept));
    assert(await test.file(processed.preview_sha256));
    // The original upload, including the location where it was taken, is gone.
    assertEquals(await test.file(row.upload_sha256), undefined);
});

Deno.test("the same picture uploaded twice is processed once, and kept once", async () => {
    let processed = 0;
    const images: ImageProcessor = {
        process: (bytes) => {
            processed += 1;
            return vips.process(bytes);
        },
        check: () => Promise.resolve(),
    };
    await using test = await open({ images });

    const first = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    const second = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    await drain(test.ctx, queues);

    assertEquals(processed, 1);
    const [one, two] = [await findMedia(test.ctx, first.id), await findMedia(test.ctx, second.id)];
    assert(one && two);
    assertEquals(two.processed_at, test.clock.now());
    assertEquals(
        [two.sha256, two.preview_sha256, two.width, two.thumbhash, two.blurhash],
        [one.sha256, one.preview_sha256, one.width, one.thumbhash, one.blurhash],
    );
    assertEquals(await test.file(first.upload_sha256), undefined);
});

Deno.test("each picture processed is announced, stored or not, even if processed with another", async () => {
    const processed: [string, boolean][] = [];
    await using test = await open({
        subscribers: [(_, event) => {
            if (isMediaProcessed(event)) processed.push([event.mediaId, event.stored]);
            return Promise.resolve();
        }],
    });
    const given = { file: new Blob([png(4, 4)]), mediaType: "image/png" };

    const first = await upload(test.ctx, "alice", given);
    await drain(test.ctx, queues);
    const second = await upload(test.ctx, "alice", given);
    const broken = await upload(test.ctx, "alice", {
        file: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])]),
        mediaType: "image/jpeg",
    });
    // A file that isn't a picture isn't processed.
    await upload(test.ctx, "alice", { file: new Blob([zip]), mediaType: "application/zip" });
    await drain(test.ctx, queues);

    assertEquals(
        processed.toSorted(),
        [
            [first.id, true],
            [second.id, true],
            [broken.id, false],
        ].toSorted(),
    );
});

Deno.test("a picture uploaded to fit a box is scaled down to fit in it as it is processed", async () => {
    await using test = await open();

    const row = await uploadPicture(test.ctx, "alice", {
        file: new Blob([png(8, 4)]),
        mediaType: "image/png",
        description: "A red box",
    }, { width: 4, height: 4 });
    assert(row);
    assertEquals([row.processed_at, row.description], [null, "A red box"]);
    assertEquals([row.fit_width, row.fit_height], [4, 4]);
    await drain(test.ctx, queues);

    const processed = await findMedia(test.ctx, row.id);
    assertEquals([processed?.width, processed?.height], [4, 2]);
});

Deno.test("a picture is processed once for each box it is uploaded to fit, and once without", async () => {
    let processed = 0;
    const images: ImageProcessor = {
        process: (bytes, fit) => {
            processed += 1;
            return vips.process(bytes, fit);
        },
        check: () => Promise.resolve(),
    };
    await using test = await open({ images });

    /** The size of the picture uploaded to fit `fit`, or as an attachment, once processed. */
    const sizeOf = async (fit?: { width: number; height: number }) => {
        const given = { file: new Blob([png(8, 4)]), mediaType: "image/png" };
        const row = fit
            ? await uploadPicture(test.ctx, "alice", given, fit)
            : await upload(test.ctx, "alice", given);
        await drain(test.ctx, queues);

        const done = await findMedia(test.ctx, row?.id ?? "");
        return [done?.width, done?.height];
    };

    assertEquals(await sizeOf({ width: 4, height: 4 }), [4, 2]);
    assertEquals(await sizeOf(), [8, 4]);
    assertEquals(await sizeOf({ width: 2, height: 4 }), [2, 1]);
    assertEquals(await sizeOf({ width: 4, height: 1 }), [2, 1]);
    assertEquals(processed, 4);

    assertEquals(await sizeOf({ width: 4, height: 4 }), [4, 2]);
    assertEquals(await sizeOf(), [8, 4]);
    assertEquals(processed, 4);
});

Deno.test("a file that isn't a picture isn't uploaded to fit a box, and nothing is kept", async () => {
    await using test = await open();

    const row = await uploadPicture(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "image/png",
    }, { width: 4, height: 4 });

    assertEquals(row, undefined);
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
    assertEquals(await test.file(await sha256Of(zip)), undefined);
    assertEquals(await test.jobs(), []);
});

Deno.test("uploading a picture as Verso keeps it doesn't remove the one kept", async () => {
    await using test = await open();
    const first = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
    });
    await drain(test.ctx, queues);
    const kept = (await findMedia(test.ctx, first.id))?.sha256 ?? null;
    const bytes = await test.file(kept);
    assert(bytes);

    // Saved from Verso, and uploaded again.
    const again = await upload(test.ctx, "alice", {
        file: new Blob([bytes]),
        mediaType: "image/jpeg",
    });
    await drain(test.ctx, queues);

    assertEquals(again.upload_sha256, kept);
    assertEquals(await test.file(kept), bytes);

    // Nor does uploading its preview.
    const preview = (await findMedia(test.ctx, first.id))?.preview_sha256 ?? null;
    const small = await test.file(preview);
    assert(small);
    await upload(test.ctx, "alice", { file: new Blob([small]), mediaType: "image/webp" });
    await drain(test.ctx, queues);
    assertEquals(await test.file(preview), small);
});

Deno.test("a picture vips refuses is removed, as it may hold metadata", async () => {
    await using test = await open();
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("oops")]);

    const row = await upload(test.ctx, "alice", {
        file: new Blob([broken]),
        mediaType: "image/jpeg",
    });
    await drain(test.ctx, queues);

    const kept = await findMedia(test.ctx, row.id);
    assertEquals(kept, {
        ...row,
        sha256: null,
        size: null,
        processed_at: test.clock.now(),
    });
    assert(kept && processingFailed(kept));
    assertEquals(await test.file(row.upload_sha256), undefined);
});

Deno.test("a picture that can't be processed is tried again, then removed", async () => {
    let tries = 0;
    const images: ImageProcessor = {
        process: () => {
            tries += 1;
            return Promise.reject(new Error("vips took over 60000 ms"));
        },
        check: () => Promise.resolve(),
    };
    await using test = await open({ images });

    const row = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    await drain(test.ctx, queues);
    assertEquals([tries, (await findMedia(test.ctx, row.id))?.processed_at], [1, null]);

    for (let i = 0; i < 2; i++) {
        test.clock.advance(24 * 60 * 60_000);
        await drain(test.ctx, queues);
    }

    assertEquals(tries, 3);
    assertEquals(await findMedia(test.ctx, row.id), {
        ...row,
        sha256: null,
        size: null,
        processed_at: test.clock.now(),
    });
    assertEquals(await test.file(row.upload_sha256), undefined);
});

Deno.test("a picture that couldn't be processed is processed anew if uploaded again", async () => {
    let fail = true;
    const images: ImageProcessor = {
        process: (bytes) =>
            fail ? Promise.resolve({ ok: false, reason: "broken" }) : vips.process(bytes),
        check: () => Promise.resolve(),
    };
    await using test = await open({ images });
    await upload(test.ctx, "alice", { file: new Blob([png(4, 4)]), mediaType: "image/png" });
    await drain(test.ctx, queues);

    fail = false;
    const again = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    await drain(test.ctx, queues);

    const kept = await findMedia(test.ctx, again.id);
    assertEquals([kept?.width, kept && processingFailed(kept)], [4, false]);
});

Deno.test("what was uploaded is removed when a run stopped after processing it", async () => {
    await using test = await open();
    const row = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
    });
    // Simulates a run that stored the image and stopped before removing the original upload.
    const kept = await test.ctx.files.put(await bytesSource(png(4, 4)), "image/png");
    await finishUpload(test.ctx, row.id, { sha256: kept });

    await drain(test.ctx, queues);

    assertEquals(await test.file(row.upload_sha256), undefined);
    assertEquals(await test.file(kept), png(4, 4));
});

Deno.test("a job for an upload that is gone, or already processed, does nothing", async () => {
    await using test = await open();
    const gone = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    await test.ctx.db.deleteFrom("media").where("id", "=", gone.id).execute();
    const done = await upload(test.ctx, "alice", {
        file: new Blob([png(5, 5)]),
        mediaType: "image/png",
    });
    await finishUpload(test.ctx, done.id, {});

    await drain(test.ctx, queues);

    assertEquals(await findMedia(test.ctx, done.id), { ...done, processed_at: test.clock.now() });
    assertEquals(await test.file(done.sha256), png(5, 5));
});

Deno.test("an upload whose file is gone isn't processed", async () => {
    await using test = await open();
    const row = await upload(test.ctx, "alice", {
        file: new Blob([png(4, 4)]),
        mediaType: "image/png",
    });
    await test.ctx.files.delete(row.sha256 ?? "");

    await drain(test.ctx, queues);

    assertEquals((await findMedia(test.ctx, row.id))?.processed_at, null);
    // Given up on at once.
    assertEquals((await test.jobs())[0].attempts, 3);
});

Deno.test("what a run keeps is removed if another run processed the upload first", async () => {
    let finishFirst = () => Promise.resolve(false);
    let made: Uint8Array<ArrayBuffer>[] = [];
    const images: ImageProcessor = {
        process: async (bytes) => {
            const result = await vips.process(bytes);
            if (result.ok) made = [result.image.bytes, result.image.preview.bytes];
            await finishFirst();
            return result;
        },
        check: () => Promise.resolve(),
    };
    await using test = await open({ images });
    const row = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
    });
    finishFirst = () => finishUpload(test.ctx, row.id, {});

    await drain(test.ctx, queues);

    assertEquals(await findMedia(test.ctx, row.id), { ...row, processed_at: test.clock.now() });
    assertEquals(made.length, 2);
    for (const bytes of made) assertEquals(await test.file(await sha256Of(bytes)), undefined);
    assertEquals(await test.file(row.sha256), sidewaysJpeg);
});

Deno.test("a file is removed only once nothing uses it", async () => {
    await using test = await open();
    const row = await upload(test.ctx, "alice", {
        file: new Blob([zip]),
        mediaType: "application/zip",
    });

    await deleteFileIfUnused(test.ctx, row.sha256 ?? "");
    assertEquals(await test.file(row.sha256), zip);

    // Neither another upload being processed nor a remote media row with the same SHA-256 uses it.
    await upload(test.ctx, "alice", { file: new Blob([png(4, 4)]), mediaType: "image/png" });
    await createInstance(test.ctx, "b.example");
    await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/notes.zip",
        mediaType: "application/zip",
        sha256: row.sha256 ?? "",
    });
    await test.ctx.db.deleteFrom("media").where("id", "=", row.id).execute();
    await deleteFileIfUnused(test.ctx, row.sha256 ?? "");
    assertEquals(await test.file(row.sha256), undefined);
});

/** A file store that waits, when asked to remove a file, until `release` is called. */
const pausingFiles = () => {
    const inner = memoryFiles();
    let release = () => {};
    const released = new Promise<void>((resolve) => release = resolve);
    let removing = () => {};
    const asked = new Promise<void>((resolve) => removing = resolve);

    const files: FileStore = {
        ...inner,
        delete: async (key) => {
            removing();
            await released;
            await inner.delete(key);
        },
    };

    return { files, inner, release, asked };
};

Deno.test("a file uploaded while it is removed as unused is kept", async () => {
    const store = pausingFiles();
    await using test = await open({ files: store.files });
    const key = await store.inner.put(await bytesSource(zip), "application/octet-stream");

    // The removal finds the file unused, then waits before removing it.
    const removing = deleteFileIfUnused(test.ctx, key);
    await store.asked;
    const uploading = upload(test.ctx, "alice", { file: new Blob([zip]), mediaType: "a zip" });
    await Promise.race([uploading, new Promise((resolve) => setTimeout(resolve, 200))]);
    store.release();
    const [row] = await Promise.all([uploading, removing]);

    assertEquals(row.sha256, key);
    assertEquals(await test.file(key), zip);
});

Deno.test("a file removed after it was uploaded, but before its row was added, is kept again", async () => {
    const inner = memoryFiles();
    let removed = false;
    const files: FileStore = {
        ...inner,
        // Simulates the removal of an unused upload deleting it at that moment.
        put: async (file, type) => {
            const key = await inner.put(file, type);
            if (!removed) {
                removed = true;
                await inner.delete(key);
            }
            return key;
        },
    };
    await using test = await open({ files });

    const row = await upload(test.ctx, "alice", { file: new Blob([zip]), mediaType: "a zip" });

    assertEquals(await test.file(row.sha256), zip);
});

Deno.test("a picture uploaded again is processed anew if what was kept of it is gone", async () => {
    await using test = await open();
    const first = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
    });
    await drain(test.ctx, queues);
    const kept = await findMedia(test.ctx, first.id);
    // Simulates it being removed, along with its files.
    await test.ctx.files.delete(kept?.sha256 ?? "");

    const again = await upload(test.ctx, "alice", {
        file: new Blob([sidewaysJpeg]),
        mediaType: "image/jpeg",
    });
    await drain(test.ctx, queues);

    const processed = await findMedia(test.ctx, again.id);
    assertEquals(processed?.sha256, kept?.sha256);
    assertEquals((await test.file(processed?.sha256 ?? null))?.length, kept?.size);
});

Deno.test("what processing keeps is kept again, if it was removed before it was used", async () => {
    const inner = memoryFiles();
    const puts = new Map<string, number>();
    const files: FileStore = {
        ...inner,
        // Simulates the removal of an unused upload deleting each file at that moment, the first
        // time it was stored: the second PNG, which is the one stored, and the preview.
        put: async (file, type) => {
            const key = await inner.put(file, type);
            const n = (puts.get(type) ?? 0) + 1;
            puts.set(type, n);
            if ((type === "image/png" && n === 2) || (type === "image/webp" && n === 1)) {
                await inner.delete(key);
            }
            return key;
        },
    };
    await using test = await open({ files });

    const row = await upload(test.ctx, "alice", {
        file: new Blob([png(40, 30)]),
        mediaType: "image/png",
    });
    await drain(test.ctx, queues);

    const processed = await findMedia(test.ctx, row.id);
    assertNotEquals(await test.file(processed?.sha256 ?? null), undefined);
    assertNotEquals(await test.file(processed?.preview_sha256 ?? null), undefined);
});
