import { assert, assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createInstance } from "../instances/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { hourMs } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { bytesSource, fileKeyOf, memoryFiles } from "../kernel/files.ts";
import { vipsImages } from "../kernel/vips_images.ts";
import { createTestContext } from "../testing/context.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { removeUnusedMedia } from "./cleanup.ts";
import { findMedia, type RemoteMedia } from "./media_queries.ts";
import type { Context } from "../kernel/context.ts";
import { deleteRemoteMedia, remoteMediaQueue, saveRemoteMedia } from "./remote_cache.ts";
import { isFileUsed } from "./upload_queries.ts";

const png = (width: number, height: number, shade = 200) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).fill(shade),
        channels: 4,
    }));

const sha256Of = fileKeyOf;

const served = (bytes: Uint8Array<ArrayBuffer>, type = "image/png") => () =>
    new Response(bytes, { headers: { "content-type": type } });

const picture = (path: string, extra: Partial<RemoteMedia> = {}): RemoteMedia => ({
    url: `https://b.example${path}`,
    mediaType: "image/png",
    ...extra,
});

/** A test context on a network where `b.example` serves `files` by path. */
const withFiles = async (
    files: Record<string, () => Response>,
    settings: Parameters<typeof createTestContext>[0] = {},
) => {
    const test = await createTestContext({
        transport: fakeTransport({
            "b.example": (request) =>
                files[new URL(request.url).pathname]?.() ??
                    new Response("Not found", { status: 404 }),
        }),
        ...settings,
    });
    await createInstance(test.ctx, "b.example");
    return test;
};

const cacheJobs = (test: { ctx: Context }) =>
    test.ctx.db.selectFrom("jobs").select(["payload", "group_key", "dedupe_key"])
        .where("queue", "=", remoteMediaQueue)
        .where("finished_at", "is", null)
        .execute();

Deno.test("a remote image is cached when it is saved, processed as an upload is", async () => {
    const image = png(40, 30);
    await using test = await withFiles({ "/bob.png": served(image) });

    const id = await test.ctx.transaction((tx) =>
        saveRemoteMedia(tx, "b.example", null, picture("/bob.png", { width: 4000 }))
    );
    assertEquals((await findMedia(test.ctx, id))?.processed_at, null);
    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assert(row?.sha256 && row.preview_sha256);
    assertEquals(row.processed_at, test.clock.now());
    assertEquals(row.cached_type, "image/png");
    assertEquals([row.width, row.height], [40, 30]);
    assertEquals([row.preview_width, row.preview_height], [40, 30]);
    assert(row.blurhash);
    assert(row.thumbhash);
    assert(await test.ctx.files.has(row.sha256));
    assert(await test.ctx.files.has(row.preview_sha256));
    // What its instance said stays as it said it.
    assertEquals([row.url, row.media_type], ["https://b.example/bob.png", "image/png"]);
    assertEquals(test.transport.sent.map((request) => request.headers.get("accept")), [
        "image/*",
    ]);
});

Deno.test("the thumbhash a remote instance gave is kept over the one caching makes", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });

    const id = await saveRemoteMedia(
        test.ctx,
        "b.example",
        null,
        picture("/bob.png", { thumbhash: "given" }),
    );
    await drain(test.ctx, queues);

    assertEquals((await findMedia(test.ctx, id))?.thumbhash, "given");
});

Deno.test("a remote file is cached only if it matches the hash its instance gave", async () => {
    const image = png(4, 4);
    await using test = await withFiles({ "/bob.png": served(image) });

    const right = await saveRemoteMedia(
        test.ctx,
        "b.example",
        null,
        picture("/bob.png", { sha256: await sha256Of(image) }),
    );
    const wrong = await saveRemoteMedia(
        test.ctx,
        "b.example",
        null,
        picture("/bob.png", { sha256: "ab".repeat(32) }),
    );
    await drain(test.ctx, queues);

    assert((await findMedia(test.ctx, right))?.sha256);
    const failed = await findMedia(test.ctx, wrong);
    assertEquals([failed?.sha256, failed?.preview_sha256], [null, null]);
    assertEquals(failed?.processed_at, test.clock.now());
});

Deno.test("remote video and audio are cached as fetched, with the type their instance gave", async () => {
    const clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]);
    await using test = await withFiles({ "/clip.mp4": served(clip, "application/octet-stream") });

    const id = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/clip.mp4",
        mediaType: "video/mp4",
        sha256: await sha256Of(clip),
    });
    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assertEquals(row?.sha256, (await bytesSource(clip)).sha256);
    assertEquals([row?.cached_type, row?.size, row?.preview_sha256], ["video/mp4", 11, null]);
    assertEquals(test.transport.sent[0].headers.get("accept"), "video/mp4");
});

Deno.test("remote files of other types, or with caching off, aren't fetched", async () => {
    await using test = await withFiles({});
    await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/paper.pdf",
        mediaType: "application/pdf",
    });
    assertEquals(await cacheJobs(test), []);

    await using off = await withFiles({}, { settings: { cacheRemoteMedia: false } });
    await saveRemoteMedia(off.ctx, "b.example", null, picture("/bob.png"));
    assertEquals(await cacheJobs(off), []);
});

Deno.test("caching is grouped by the host the file is on, once for each URL", async () => {
    await using test = await withFiles({});

    const id = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://cdn.b.example/bob.png",
        mediaType: "image/png",
    });
    await saveRemoteMedia(test.ctx, "b.example", id, {
        url: "https://cdn.b.example/bob.png",
        mediaType: "image/png",
    });

    assertEquals(await cacheJobs(test), [{
        payload: { mediaId: id, url: "https://cdn.b.example/bob.png" },
        group_key: "cdn.b.example",
        dedupe_key: `remote-media:${id}:https://cdn.b.example/bob.png`,
    }]);
});

Deno.test("a file that can't be fetched is tried again, then not cached", async () => {
    await using test = await withFiles({});
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/gone.png"));

    for (let attempt = 1; attempt <= 3; attempt++) {
        await drain(test.ctx, queues);
        assertEquals(
            (await findMedia(test.ctx, id))?.processed_at,
            attempt < 3 ? null : test.clock.now(),
        );
        test.clock.advance(hourMs);
    }

    assertEquals(test.transport.sent.length, 3);
    assertEquals((await findMedia(test.ctx, id))?.sha256, null);
});

Deno.test("a file too large, or an image that isn't one, isn't cached", async () => {
    await using test = await withFiles(
        { "/big.png": served(png(64, 64)), "/text.png": served(new TextEncoder().encode("hi")) },
        { settings: { maxUploadBytes: 100 } },
    );

    const big = await saveRemoteMedia(test.ctx, "b.example", null, picture("/big.png"));
    const text = await saveRemoteMedia(test.ctx, "b.example", null, picture("/text.png"));
    await drain(test.ctx, queues);

    for (const id of [big, text]) {
        const row = await findMedia(test.ctx, id);
        assertEquals([row?.sha256, row?.processed_at], [null, test.clock.now()]);
    }
});

Deno.test("an image at its limit exactly is cached", async () => {
    const image = png(4, 4);
    await using test = await withFiles({ "/bob.png": served(image) }, {
        settings: { maxUploadBytes: image.length },
    });

    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);

    assert((await findMedia(test.ctx, id))?.sha256);
});

Deno.test("saving the same file again keeps what caching found, but not its old description", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);
    const cached = await findMedia(test.ctx, id);
    assert(cached);

    await saveRemoteMedia(test.ctx, "b.example", id, picture("/bob.png", { description: "Bob" }));

    assertEquals(await findMedia(test.ctx, id), { ...cached, description: "Bob" });
    assertEquals(await cacheJobs(test), []);
});

Deno.test("a file that failed to cache isn't tried again when it is saved again", async () => {
    await using test = await withFiles({});
    const id = await saveRemoteMedia(
        test.ctx,
        "b.example",
        null,
        picture("/bob.png", { sha256: "ab".repeat(32) }),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
        await drain(test.ctx, queues);
        test.clock.advance(hourMs);
    }

    await saveRemoteMedia(
        test.ctx,
        "b.example",
        id,
        picture("/bob.png", { sha256: "ab".repeat(32) }),
    );

    assertEquals(await cacheJobs(test), []);
});

Deno.test("another file in place of a cached one is cached, and the old files removed", async () => {
    await using test = await withFiles({
        "/old.png": served(png(4, 4, 10)),
        "/new.png": served(png(4, 4, 250)),
    });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/old.png"));
    await drain(test.ctx, queues);
    const old = await findMedia(test.ctx, id);
    assert(old?.sha256 && old.preview_sha256);

    await test.ctx.transaction((tx) =>
        saveRemoteMedia(tx, "b.example", id, picture("/new.png", { width: 9 }))
    );
    const pending = await findMedia(test.ctx, id);
    assertEquals(
        [pending?.sha256, pending?.preview_sha256, pending?.processed_at, pending?.cached_type],
        [null, null, null, null],
    );
    assertEquals([pending?.preview_width, pending?.blurhash, pending?.width], [null, null, 9]);

    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assert(row?.sha256 && row.sha256 !== old.sha256);
    assertEquals(await test.ctx.files.has(old.sha256), false);
    assertEquals(await test.ctx.files.has(old.preview_sha256), false);
});

Deno.test("the same URL with another hash is another file", async () => {
    const image = png(4, 4);
    await using test = await withFiles({ "/bob.png": served(image) });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);

    await saveRemoteMedia(
        test.ctx,
        "b.example",
        id,
        picture("/bob.png", { sha256: await sha256Of(image) }),
    );

    assertEquals((await findMedia(test.ctx, id))?.processed_at, null);
    await drain(test.ctx, queues);
    assert((await findMedia(test.ctx, id))?.sha256);
});

Deno.test("a job for a URL that was replaced before it ran does nothing", async () => {
    await using test = await withFiles({ "/old.png": served(png(4, 4)) });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/old.png"));
    await saveRemoteMedia(test.ctx, "b.example", id, {
        url: "https://b.example/paper.pdf",
        mediaType: "application/pdf",
    });

    await drain(test.ctx, queues);

    assertEquals(test.transport.sent, []);
    assertEquals((await findMedia(test.ctx, id))?.processed_at, null);
});

Deno.test("files stored for a URL that was replaced while it was fetched are removed", async () => {
    const stored: string[] = [];
    const files = memoryFiles();
    const images = vipsImages({ maxPixels: 8_294_400 });
    let replace = async () => {};
    await using test = await withFiles({ "/old.png": served(png(4, 4)) }, {
        files: {
            ...files,
            put: async (file, type) => stored[stored.push(await files.put(file, type)) - 1],
        },
        images: {
            ...images,
            process: async (input) => {
                await replace();
                return await images.process(input);
            },
        },
    });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/old.png"));
    replace = async () => {
        await saveRemoteMedia(test.ctx, "b.example", id, {
            url: "https://b.example/paper.pdf",
            mediaType: "application/pdf",
        });
    };

    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assertEquals([row?.url, row?.sha256, row?.processed_at], [
        "https://b.example/paper.pdf",
        null,
        null,
    ]);
    assertEquals(stored.length, 2);
    for (const key of stored) assertEquals(await files.has(key), false);
});

Deno.test("deleted remote media's cached files are removed, unless other media uses them", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });
    const one = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    const two = await saveRemoteMedia(test.ctx, "b.example", null, {
        ...picture("/bob.png"),
        description: "Same file",
    });
    await drain(test.ctx, queues);
    const row = await findMedia(test.ctx, one);
    assert(row?.sha256 && row.preview_sha256);
    assertEquals((await findMedia(test.ctx, two))?.sha256, row.sha256);

    await test.ctx.transaction((tx) => deleteRemoteMedia(tx, [one]));
    await drain(test.ctx, queues);
    assert(await test.ctx.files.has(row.sha256));
    assert(await isFileUsed(test.ctx, row.sha256));
    assert(await isFileUsed(test.ctx, row.preview_sha256));

    await test.ctx.transaction((tx) => deleteRemoteMedia(tx, [two]));
    await drain(test.ctx, queues);
    assertEquals(await test.ctx.files.has(row.sha256), false);
    assertEquals(await test.ctx.files.has(row.preview_sha256), false);
});

Deno.test("deleting no remote media queues nothing", async () => {
    await using test = await withFiles({});

    await deleteRemoteMedia(test.ctx, []);

    assertEquals(await test.ctx.db.selectFrom("jobs").select("id").execute(), []);
});

Deno.test("unused remote media is removed with the files it cached", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);
    const row = await findMedia(test.ctx, id);
    assert(row?.sha256 && row.preview_sha256);

    test.clock.advance(test.ctx.settings.unattachedMs);
    await removeUnusedMedia(test.ctx);

    assertEquals(await findMedia(test.ctx, id), undefined);
    assertEquals(await test.ctx.files.has(row.sha256), false);
    assertEquals(await test.ctx.files.has(row.preview_sha256), false);
});

Deno.test("nothing is fetched from a blocked instance, or a blocked host", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });
    // Instances' ids aren't their domains, other than in tests that make them so.
    await test.ctx.db.insertInto("instances").values({
        id: "c",
        domain: "c.example",
        protocol: "versia",
        public_key: null,
        key_fetched_at: null,
        created_at: test.clock.now(),
    }).execute();
    // On a host that isn't blocked, from an instance that is.
    const fromBlocked = await saveRemoteMedia(test.ctx, "c", null, picture("/bob.png"));
    // On a host that is blocked, from an instance that isn't.
    const onBlocked = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://cdn.c.example/bob.png",
        mediaType: "image/png",
    });
    await blockDomain(test.ctx, "c.example");

    await drain(test.ctx, queues);

    assertEquals(test.transport.sent, []);
    for (const id of [fromBlocked, onBlocked]) {
        assertEquals((await findMedia(test.ctx, id))?.processed_at, null);
    }
});

Deno.test("video and audio are cached up to their own limit, not the one for images", async () => {
    const clip = new Uint8Array(64);
    await using test = await withFiles({ "/clip.mp4": served(clip, "video/mp4") }, {
        settings: { maxUploadBytes: 10 },
    });

    const id = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/clip.mp4",
        mediaType: "video/mp4",
    });
    await drain(test.ctx, queues);

    assertEquals((await findMedia(test.ctx, id))?.size, 64);
    assert((await findMedia(test.ctx, id))?.sha256);
});

Deno.test("a job for media already cached fetches nothing", async () => {
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) });
    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);
    const cached = await findMedia(test.ctx, id);

    await enqueue(test.ctx, {
        queue: remoteMediaQueue,
        payload: { mediaId: id, url: "https://b.example/bob.png" },
    });
    await drain(test.ctx, queues);

    assertEquals(test.transport.sent.length, 1);
    assertEquals(await findMedia(test.ctx, id), cached);
});

Deno.test("a cached file removed before caching finishes is stored again", async () => {
    const files = memoryFiles();
    const removed = new Set<string>();
    await using test = await withFiles({ "/bob.png": served(png(4, 4)) }, {
        // Cleanup removes each file the first time it is stored. It could do that between the job
        // storing the file and the transaction that starts using it.
        files: {
            ...files,
            put: async (file, type) => {
                const key = await files.put(file, type);
                if (!removed.has(key)) {
                    removed.add(key);
                    await files.delete(key);
                }
                return key;
            },
        },
    });

    const id = await saveRemoteMedia(test.ctx, "b.example", null, picture("/bob.png"));
    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assert(row?.sha256 && row.preview_sha256);
    assert(await files.has(row.sha256));
    assert(await files.has(row.preview_sha256));
});
