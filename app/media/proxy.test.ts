import { assert, assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { fakeClock } from "../kernel/clock.ts";
import { fakeTransport } from "../kernel/fake_transport.ts";
import type { Visibility } from "../kernel/visibility.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { suspend } from "../moderation/suspensions.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { insertAttachments } from "./attachment_queries.ts";
import { findMedia } from "./media_queries.ts";
import { mediaProxyRoutes } from "./proxy.ts";
import { saveRemoteMedia } from "./remote_cache.ts";
import { mediaRoutes } from "./routes.ts";
import { memoryRateLimitStore } from "../http/rate_limits.ts";
import { Limits, MediaLimits } from "../kernel/config_sections.ts";

const png = new Uint8Array(encode({
    width: 8,
    height: 6,
    data: new Uint8Array(8 * 6 * 4).fill(200),
    channels: 4,
}));

/**
 * An instance where bob, of `b.example`, which serves a PNG at `/bob.png`, and at `/down.png` once
 * it is up, posted a status, and alice is a local user. Requests to `b.example` are counted.
 */
const open = async (
    settings: Parameters<typeof createTestContext>[0] = {},
    rateLimits?: NonNullable<Parameters<typeof createTestApp>[2]>["rateLimits"],
) => {
    let fetched = 0;
    let up = false;
    const test = await createTestContext({
        transport: fakeTransport({
            "b.example": (request) => {
                fetched++;
                const { pathname } = new URL(request.url);
                return pathname === "/bob.png" || (up && pathname === "/down.png")
                    ? new Response(png, { headers: { "content-type": "image/png" } })
                    : new Response("Unavailable", { status: 503 });
            },
        }),
        ...settings,
    });
    const app = createTestApp(
        test.ctx,
        [...mediaRoutes(MediaLimits.parse({}), Limits.parse({})), ...mediaProxyRoutes],
        { checkResponses: true, rateLimits },
    );
    const instance = await createInstance(test.ctx, "b.example");
    const bob = await createRemoteAccount(test.ctx, "bob", instance);
    const alice = await createLocalAccount(test.ctx, "alice");

    /** Remote media at `path` on `b.example`, attached to a status of bob's. */
    const attached = async (
        path = "/bob.png",
        mediaType = "image/png",
        visibility: Visibility = "public",
    ) => {
        const id = await saveRemoteMedia(test.ctx, instance, null, {
            url: `https://b.example${path}`,
            mediaType,
        });
        const note = await createNote(test.ctx, bob, { visibility });
        await insertAttachments(test.ctx, note.id, [id]);

        return id;
    };

    /** The proxy's answer for `path`, as alice if `signedIn`. */
    const proxy = async (path: string, signedIn = false) => {
        const headers: Record<string, string> = signedIn
            ? { authorization: `Bearer ${await tokenFor(test.ctx, alice)}` }
            : {};
        const response = await app.request(path, { headers });
        await response.body?.cancel();

        return {
            status: response.status,
            location: response.headers.get("location"),
            cache: response.headers.get("cache-control"),
        };
    };

    return {
        ...test,
        app,
        bob,
        alice,
        attached,
        proxy,
        fetched: () => fetched,
        bringUp: () => {
            up = true;
        },
    };
};

Deno.test("the media proxy caches remote media and redirects to it", async () => {
    await using test = await open();
    const id = await test.attached();

    const original = await test.proxy(`/media/proxy/${id}`);
    const row = await findMedia(test.ctx, id);
    assert(row?.sha256 && row.preview_sha256);
    assertEquals(original, {
        status: 302,
        location: `https://social.example/media/${row.sha256}`,
        cache: "no-store",
    });
    assertEquals(test.fetched(), 1);

    // Once cached, it isn't fetched again.
    assertEquals(
        (await test.proxy(`/media/proxy/${id}/small`)).location,
        `https://social.example/media/${row.preview_sha256}`,
    );
    assertEquals(test.fetched(), 1);

    const served = await test.app.request(`/media/${row.sha256}`);
    assertEquals([served.status, served.headers.get("content-type")], [200, "image/png"]);
    await served.body?.cancel();
});

Deno.test("the media proxy redirects to the file for the preview of what has none", async () => {
    await using test = await open();
    const id = await test.attached();
    await test.proxy(`/media/proxy/${id}`);
    await test.ctx.db.updateTable("media").set({ preview_sha256: null }).execute();
    const row = await findMedia(test.ctx, id);

    assertEquals(
        (await test.proxy(`/media/proxy/${id}/small`)).location,
        `https://social.example/media/${row?.sha256}`,
    );
});

Deno.test("the media proxy only serves remote media attached to statuses one may see", async () => {
    await using test = await open();
    const unattached = await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/bob.png",
        mediaType: "image/png",
    });
    const local = await createNote(test.ctx, test.alice);
    await test.ctx.db.insertInto("media").values({
        id: "local",
        instance_id: null,
        url: null,
        media_type: "image/png",
        created_at: test.clock.now(),
    }).execute();
    await insertAttachments(test.ctx, local.id, ["local"]);

    for (const id of [unattached, "local", "nope"]) {
        assertEquals((await test.proxy(`/media/proxy/${id}`)).status, 404, id);
    }

    // A status for bob's followers is seen by alice only once she follows him.
    const followers = await test.attached("/bob.png", "image/png", "private");
    assertEquals((await test.proxy(`/media/proxy/${followers}`, true)).status, 404);
    assertEquals(test.fetched(), 0);

    await test.ctx.db.insertInto("follows").values({
        id: "f",
        follower_id: test.alice,
        followee_id: test.bob,
        accepted: true,
        created_at: test.clock.now(),
    }).execute();

    assertEquals((await test.proxy(`/media/proxy/${followers}`)).status, 404);
    assertEquals((await test.proxy(`/media/proxy/${followers}`, true)).status, 302);

    // Nobody sees a suspended account's statuses.
    const shown = await test.attached();
    await suspend(test.ctx, test.bob);

    assertEquals((await test.proxy(`/media/proxy/${shown}`)).status, 404);
});

Deno.test("the media proxy fetches nothing from blocked instances and hosts", async () => {
    await using test = await open();
    const id = await test.attached();
    await blockDomain(test.ctx, "b.example");

    assertEquals((await test.proxy(`/media/proxy/${id}`)).status, 404);
    assertEquals(test.fetched(), 0);
    assertEquals((await findMedia(test.ctx, id))?.processed_at, null);
});

Deno.test("media the proxy couldn't fetch is left to be cached later", async () => {
    await using test = await open();
    const id = await test.attached("/down.png");

    assertEquals((await test.proxy(`/media/proxy/${id}`)).status, 404);
    assertEquals(test.fetched(), 1);
    assertEquals((await findMedia(test.ctx, id))?.processed_at, null);

    // The job queued when it was saved still caches it.
    test.bringUp();
    await drain(test.ctx, queues);

    assertEquals(typeof (await findMedia(test.ctx, id))?.sha256, "string");
});

Deno.test("the media proxy doesn't fetch what won't be cached", async () => {
    await using test = await open();
    const failed = await test.attached();
    await test.ctx.db.updateTable("media").set({ processed_at: test.clock.now() }).execute();
    const zip = await test.attached("/notes.zip", "application/zip");

    for (const id of [failed, zip]) {
        assertEquals((await test.proxy(`/media/proxy/${id}`)).status, 404, id);
    }

    assertEquals(test.fetched(), 0);

    await using off = await open({ settings: { cacheRemoteMedia: false } });
    const uncached = await off.attached();

    assertEquals((await off.proxy(`/media/proxy/${uncached}`)).status, 404);
    assertEquals(off.fetched(), 0);
});

Deno.test("the media proxy's requests are counted apart from those for files", async () => {
    const policy = { limit: 2, windowSeconds: 30 };
    await using test = await open({}, {
        store: memoryRateLimitStore(fakeClock()),
        policy,
        instancePolicy: policy,
    });
    const status = async (path: string) => {
        const response = await test.app.request(path);
        await response.body?.cancel();

        return response.status;
    };

    for (let i = 0; i < 3; i++) assertEquals(await status(`/media/${"0".repeat(64)}`), 404);
    assertEquals(await status("/media/proxy/nope"), 404);
    assertEquals(await status("/media/proxy/nope/small"), 404);
    assertEquals(await status("/media/proxy/nope"), 429);
});
