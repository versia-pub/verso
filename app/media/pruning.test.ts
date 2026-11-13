import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CompiledQuery, sql } from "kysely";
import { encode } from "fast-png";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { testDatabaseKind } from "../db/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { schedule } from "../jobs/scheduler.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { drain, PermanentFailure } from "../jobs/worker.ts";
import { dayMs } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import { bytesSource } from "../kernel/files.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { insertAttachments } from "./attachment_queries.ts";
import { findMedia } from "./media_queries.ts";
import { mediaProxyRoutes } from "./proxy.ts";
import {
    mediaPruneHandler,
    mediaPruneQueue,
    pruneRemoteMedia,
    startMediaPruning,
} from "./pruning.ts";
import { oldCachedQuery, uncacheMedia } from "./pruning_queries.ts";
import { saveRemoteMedia } from "./remote_cache.ts";
import { renderAttachment } from "./render.ts";

const png = new Uint8Array(encode({
    width: 8,
    height: 6,
    data: new Uint8Array(8 * 6 * 4).fill(200),
    channels: 4,
}));

/** An instance where bob, of `b.example`, which serves a PNG at `/bob.png`, posted statuses. */
const open = async (settings: Parameters<typeof createTestContext>[0] = {}) => {
    let fetched = 0;
    const test = await createTestContext({
        transport: fakeTransport({
            "b.example": () => {
                fetched++;
                return new Response(png, { headers: { "content-type": "image/png" } });
            },
        }),
        ...settings,
    });
    const instance = await createInstance(test.ctx, "b.example");
    const bob = await createRemoteAccount(test.ctx, "bob", instance);

    return { ...test, instance, bob, fetched: () => fetched };
};

type Test = Awaited<ReturnType<typeof open>>;

/** Remote media at `path`, cached `daysAgo` days ago, attached to a status of bob's. */
const cachedAttachment = async (test: Test, path: string, daysAgo: number) => {
    const id = await saveRemoteMedia(test.ctx, test.instance, null, {
        url: `https://b.example${path}`,
        mediaType: "image/png",
    });
    await insertAttachments(test.ctx, (await createNote(test.ctx, test.bob)).id, [id]);
    await drain(test.ctx, queues);
    await cachedAgo(test, id, daysAgo);

    return id;
};

/** Marks the media `id` as cached `daysAgo` days ago. */
const cachedAgo = async (test: Test, id: string, daysAgo: number) => {
    await test.ctx.db.updateTable("media")
        .set({ processed_at: new Date(test.clock.now().getTime() - daysAgo * dayMs) })
        .where("id", "=", id)
        .execute();
};

/** Whether the media `id` still has the files it cached. */
const isCached = async (ctx: Context, id: string) => {
    const row = await findMedia(ctx, id);
    return row?.sha256 != null && await ctx.files.has(row.sha256);
};

/** Prunes what was cached more than `days` days ago, as the command does. */
const prune = (ctx: Context, days: number) =>
    pruneRemoteMedia(ctx, new Date(ctx.clock.now().getTime() - days * dayMs));

Deno.test("an old cached attachment loses its files, and is fetched again when asked for", async () => {
    await using test = await open();
    const id = await cachedAttachment(test, "/bob.png", 10);
    const before = await findMedia(test.ctx, id);
    assert(before?.sha256 && before.preview_sha256);

    assertEquals(await prune(test.ctx, 7), 1);
    await drain(test.ctx, queues);

    const row = await findMedia(test.ctx, id);
    assertEquals(
        [row?.sha256, row?.preview_sha256, row?.cached_type, row?.processed_at],
        [null, null, null, null],
    );
    assertEquals(await test.ctx.files.has(before.sha256), false);
    assertEquals(await test.ctx.files.has(before.preview_sha256), false);

    // What is known of it is kept.
    assertEquals(
        [row?.width, row?.height, row?.blurhash, row?.preview_width],
        [before.width, before.height, before.blurhash, before.preview_width],
    );

    // Clients are given the proxy's URL, which caches it again, starting its time over.
    assert(row);
    assertEquals(
        renderAttachment(test.ctx, row).url,
        `https://social.example/media/proxy/${id}`,
    );

    const app = createTestApp(test.ctx, mediaProxyRoutes);
    const response = await app.request(`/media/proxy/${id}`);
    await response.body?.cancel();

    assertEquals(response.status, 302);
    assertEquals(test.fetched(), 2);
    assertEquals((await findMedia(test.ctx, id))?.processed_at, test.clock.now());
    assertEquals(await prune(test.ctx, 7), 0);
});

Deno.test("only attachments cached before the cutoff are pruned", async () => {
    await using test = await open();
    const old = await cachedAttachment(test, "/old.png", 8);
    const cutoff = await cachedAttachment(test, "/cutoff.png", 7);
    const recent = await cachedAttachment(test, "/recent.png", 6);

    const before = new Date(test.clock.now().getTime() - 7 * dayMs);
    const found = await oldCachedQuery(test.ctx, before, 500).execute();
    assertEquals(found.map((row) => row.id), [old]);

    assertEquals(await prune(test.ctx, 7), 1);
    assertEquals(
        [
            await isCached(test.ctx, old),
            await isCached(test.ctx, cutoff),
            await isCached(test.ctx, recent),
        ],
        [false, true, true],
    );
});

Deno.test("avatars, emojis, unattached, failed and local media aren't pruned", async () => {
    await using test = await open();
    const save = (path: string) =>
        saveRemoteMedia(test.ctx, test.instance, null, {
            url: `https://b.example${path}`,
            mediaType: "image/png",
        });
    const avatar = await save("/avatar.png");
    await test.ctx.db.updateTable("accounts").set({ avatar_id: avatar })
        .where("id", "=", test.bob).execute();
    const emoji = await save("/blob.png");
    await test.ctx.db.insertInto("emojis").values({
        id: "blob",
        instance_id: test.instance,
        account_id: null,
        shortcode: "blob",
        media_id: emoji,
        category: null,
        created_at: test.clock.now(),
    }).execute();
    const unattached = await save("/unattached.png");
    const failed = await cachedAttachment(test, "/failed.png", 0);
    await drain(test.ctx, queues);
    await test.ctx.db.updateTable("media").set({ sha256: null, preview_sha256: null })
        .where("id", "=", failed).execute();

    const alice = await createLocalAccount(test.ctx, "alice");
    const file = await bytesSource(png);
    await test.ctx.files.put(file, "image/png");
    await test.ctx.db.insertInto("media").values({
        id: "local",
        instance_id: null,
        url: null,
        media_type: "image/png",
        sha256: file.sha256,
        processed_at: test.clock.now(),
        created_at: test.clock.now(),
    }).execute();
    await insertAttachments(test.ctx, (await createNote(test.ctx, alice)).id, ["local"]);

    const all = [avatar, emoji, unattached, failed, "local"];
    for (const id of all) await cachedAgo(test, id, 30);
    const rows = async () =>
        await test.ctx.db.selectFrom("media").selectAll().where("id", "in", all).orderBy("id")
            .execute();
    const unpruned = await rows();
    for (const id of [avatar, emoji, unattached]) assert(await isCached(test.ctx, id), id);

    assertEquals(await prune(test.ctx, 7), 0);
    assertEquals(await rows(), unpruned);
});

Deno.test("only the media given that were cached before the cutoff are marked not cached", async () => {
    await using test = await open();
    const old = await cachedAttachment(test, "/old.png", 8);
    const edge = await cachedAttachment(test, "/edge.png", 7);
    const recent = await cachedAttachment(test, "/recent.png", 6);
    const other = await cachedAttachment(test, "/other.png", 8);
    const failed = await cachedAttachment(test, "/failed.png", 8);
    await test.ctx.db.updateTable("media").set({ sha256: null, preview_sha256: null })
        .where("id", "=", failed).execute();

    const cutoff = new Date(test.clock.now().getTime() - 7 * dayMs);

    assertEquals(await uncacheMedia(test.ctx, [old, edge, recent, failed], cutoff), 1);
    assertEquals(
        [
            await isCached(test.ctx, old),
            await isCached(test.ctx, edge),
            await isCached(test.ctx, recent),
            await isCached(test.ctx, other),
        ],
        [false, true, true, true],
    );
    assert((await findMedia(test.ctx, failed))?.processed_at);
});

Deno.test("a file another media uses is kept when an attachment is pruned", async () => {
    await using test = await open();
    const old = await cachedAttachment(test, "/old.png", 8);
    // The same picture, cached since.
    const recent = await cachedAttachment(test, "/recent.png", 1);
    const key = (await findMedia(test.ctx, recent))?.sha256;

    assert(key);

    assertEquals(await prune(test.ctx, 7), 1);

    await drain(test.ctx, queues);

    assertEquals(await isCached(test.ctx, old), false);
    assert(await test.ctx.files.has(key));
});

/** `count` attachments of a status of bob's, cached 8 days ago. */
const oldAttachments = async (test: Test, count: number) => {
    const ids = Array.from({ length: count }, (_, index) => `m${String(index).padStart(4, "0")}`);
    await test.ctx.db.insertInto("media").values(ids.map((id) => ({
        id,
        instance_id: test.instance,
        url: `https://b.example/${id}.png`,
        media_type: "image/png",
        sha256: "f".repeat(64),
        cached_type: "image/png",
        processed_at: new Date(test.clock.now().getTime() - 8 * dayMs),
        created_at: test.clock.now(),
    }))).execute();
    await insertAttachments(test.ctx, (await createNote(test.ctx, test.bob)).id, ids);
};

Deno.test("the command's pass prunes every batch, up to the last", async () => {
    await using test = await open();
    await oldAttachments(test, 1000);

    assertEquals(await prune(test.ctx, 7), 1000);
});

Deno.test("each day, attachments cached more than remote_media_days ago are pruned, in batches", async () => {
    await using test = await open({ settings: { remoteMediaMs: 7 * dayMs } });
    const recent = await cachedAttachment(test, "/recent.png", 6);
    const old = await cachedAttachment(test, "/old.png", 8);
    await oldAttachments(test, 1200);

    let jobs = 0;
    const counted = {
        ...queues,
        [mediaPruneQueue]: {
            ...queues[mediaPruneQueue],
            handler: (ctx: Context, job: JobsTable) => {
                jobs++;
                return mediaPruneHandler(ctx, job);
            },
        },
    };
    await schedule(test.ctx, tasks);
    await drain(test.ctx, counted);

    // 1,201 old attachments: two full batches of 500, then the rest.
    assertEquals(jobs, 3);

    assertEquals([await isCached(test.ctx, recent), await isCached(test.ctx, old)], [true, false]);
    const left = await test.ctx.db.selectFrom("media").select("id")
        .where("instance_id", "is not", null)
        .where("sha256", "is not", null)
        .execute();

    assertEquals(left.map((row) => row.id), [recent]);
});

Deno.test("each day's pass is queued apart from the day before's", async () => {
    await using test = await open();
    await startMediaPruning(test.ctx);
    test.clock.advance(dayMs);
    await startMediaPruning(test.ctx);

    const jobs = await test.ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", mediaPruneQueue).execute();

    assertEquals(jobs.map((job) => (job.payload as { batch: number }).batch), [0, 0]);
});

Deno.test("a media prune job that can't be read fails for good", async () => {
    await using test = await open();
    await enqueue(test.ctx, { queue: mediaPruneQueue, payload: { before: "yesterday" } });
    const job = await test.ctx.db.selectFrom("jobs").selectAll()
        .where("queue", "=", mediaPruneQueue).executeTakeFirstOrThrow();

    await assertRejects(() => mediaPruneHandler(test.ctx, job), PermanentFailure);
});

Deno.test("old cached media is read by index", async () => {
    await using test = await open();
    const { db } = test.ctx;
    const old = oldCachedQuery(test.ctx, test.clock.now(), 500).compile();

    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${old.sql}`, [...old.parameters]),
        );

        assertStringIncludes(
            plan.rows.map((row) => row.detail).join("\n"),
            "media_remote_by_cache",
        );

        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (format json) ${old.sql}`, [...old.parameters]),
    );

    assertStringIncludes(JSON.stringify(plan.rows), '"Index Name":"media_remote_by_cache"');
});
