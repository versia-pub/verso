import { assert, assertEquals } from "@std/assert";
import { encode } from "fast-png";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { Limits, MediaLimits } from "../kernel/config_sections.ts";
import { bytesSource, type FileStore, memoryFiles } from "../kernel/files.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createInstance } from "../instances/testing.ts";
import { findMedia, saveRemoteMedia } from "./media_queries.ts";
import { mediaRoutes } from "./routes.ts";

/** A `width`×`height` PNG, entirely red. */
const png = (width: number, height: number) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).map((_, i) => [200, 30, 30, 255][i % 4]),
        channels: 4,
    }));

const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

const open = async (
    limits = MediaLimits.parse({}),
    files?: FileStore,
    textLimits = Limits.parse({}),
) => {
    const test = await createTestContext({ files });
    const app = createTestApp(test.ctx, mediaRoutes(limits, textLimits), { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");

    const request = async (
        method: string,
        path: string,
        options: { form?: FormData; json?: unknown; as?: string; scopes?: Scope[] } = {},
    ) => {
        const token = await tokenFor(test.ctx, options.as ?? "alice", options.scopes);
        const response = await app.request(path, {
            method,
            body: options.form ??
                (options.json === undefined ? undefined : JSON.stringify(options.json)),
            headers: {
                authorization: `Bearer ${token}`,
                ...options.json !== undefined && { "content-type": "application/json" },
            },
        });

        return { status: response.status, body: await response.json() };
    };

    /** Uploads `bytes` as a file of `type`, with any other form fields. */
    const upload = (bytes: Uint8Array<ArrayBuffer>, type: string, fields = {}, as?: string) => {
        const form = new FormData();
        form.append("file", new File([bytes], "upload", { type }));
        for (const [name, value] of Object.entries(fields)) form.append(name, String(value));

        return request("POST", "/api/v2/media", { form, as });
    };

    /** The file at `url` as served, with the headers that describe how it is served. */
    const download = async (url: string) => {
        const response = await app.request(new URL(url).pathname);

        return {
            status: response.status,
            type: response.headers.get("content-type"),
            disposition: response.headers.get("content-disposition"),
            cache: response.headers.get("cache-control"),
            bytes: new Uint8Array(await response.arrayBuffer()),
        };
    };

    return { ...test, app, request, upload, download };
};

const sha256Of = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

Deno.test("a file that isn't a picture is ready at once, as a file", async () => {
    await using test = await open();

    const uploaded = await test.upload(zip, "application/zip", { description: "My notes" });

    assertEquals(uploaded, {
        status: 200,
        body: {
            id: uploaded.body.id,
            type: "unknown",
            url: `https://social.example/media/${await sha256Of(zip)}`,
            preview_url: null,
            remote_url: null,
            meta: null,
            description: "My notes",
            blurhash: null,
        },
    });
    assertEquals(await test.request("GET", `/api/v1/media/${uploaded.body.id}`), uploaded);
    assertEquals((await findMedia(test.ctx, uploaded.body.id))?.media_type, "application/zip");
});

Deno.test("a picture is answered with 202, then 206, until it is processed", async () => {
    await using test = await open();

    const uploaded = await test.upload(png(40, 30), "image/png", { focus: "0.5,-0.25" });

    assertEquals(uploaded.status, 202);
    assertEquals(uploaded.body.type, "image");
    assertEquals(uploaded.body.url, null);
    assertEquals(uploaded.body.meta, { focus: { x: 0.5, y: -0.25 } });
    const path = `/api/v1/media/${uploaded.body.id}`;
    assertEquals(await test.request("GET", path), { ...uploaded, status: 206 });

    await drain(test.ctx, queues);
    const processed = await test.request("GET", path);

    assertEquals([processed.status, processed.body.type], [200, "image"]);
    assert(processed.body.url.startsWith("https://social.example/media/"));
    assert(processed.body.preview_url.startsWith("https://social.example/media/"));
    assertEquals(processed.body.meta, {
        original: { width: 40, height: 30, size: "40x30", aspect: 40 / 30 },
        small: { width: 40, height: 30, size: "40x30", aspect: 40 / 30 },
        focus: { x: 0.5, y: -0.25 },
    });
    assert(processed.body.blurhash);
});

Deno.test("an upload's description and focus can be changed by whoever uploaded it", async () => {
    await using test = await open();
    const { body } = await test.upload(zip, "application/zip", { description: "My notes" });
    const path = `/api/v1/media/${body.id}`;

    const changed = await test.request("PUT", path, { json: { focus: "0,1" } });
    assertEquals(changed.status, 200);
    assertEquals([changed.body.description, changed.body.meta], ["My notes", {
        focus: { x: 0, y: 1 },
    }]);

    const cleared = await test.request("PUT", path, { json: { description: "" } });
    assertEquals([cleared.body.description, cleared.body.meta], [null, { focus: { x: 0, y: 1 } }]);
    assertEquals((await test.request("PUT", path, { json: {} })).body, cleared.body);

    // No other account can see or change it.
    assertEquals((await test.request("GET", path, { as: "bob" })).status, 404);
    assertEquals((await test.request("PUT", path, { as: "bob", json: {} })).status, 404);
    assertEquals((await test.request("GET", "/api/v1/media/nope")).status, 404);
});

Deno.test("a picture is answered with 206 when it is changed while it is processed", async () => {
    await using test = await open();
    const { body } = await test.upload(png(4, 4), "image/png");

    const changed = await test.request("PUT", `/api/v1/media/${body.id}`, {
        json: { description: "Red" },
    });

    assertEquals([changed.status, changed.body.description], [206, "Red"]);
});

Deno.test("a picture that couldn't be processed is answered with 422", async () => {
    await using test = await open();
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("oops")]);
    const { body } = await test.upload(broken, "image/jpeg");
    await drain(test.ctx, queues);
    const path = `/api/v1/media/${body.id}`;

    const refused = async (method: string, json?: unknown) => {
        const reply = await test.request(method, path, { json });
        return [reply.status, reply.body.error_description];
    };

    const error = [422, "Error processing thumbnail for uploaded media"];
    assertEquals(await refused("GET"), error);
    assertEquals(await refused("PUT", { description: "Hi" }), error);
});

Deno.test("what is uploaded is checked", async () => {
    await using test = await open(MediaLimits.parse({ max_upload_bytes: 100 }));
    const refused = async (fields: Record<string, string>) =>
        (await test.upload(zip, "application/zip", fields)).status;

    for (const point of ["1", "0.5,2", "a,b", "-1.5,0", "0,0,0"]) {
        assertEquals(await refused({ focus: point }), 422, point);
    }
    assertEquals(await refused({ focus: "-1,1.0" }), 200);
    assertEquals(await refused({ description: "x".repeat(4001) }), 422);
    assertEquals(await refused({ description: "x".repeat(4000) }), 200);
    assertEquals(await refused({ thumbnail: "x" }), 422);
    assertEquals((await test.request("POST", "/api/v2/media", { json: {} })).status, 422);

    // A file over the limit is rejected, and a body far over it isn't even read.
    assertEquals((await test.upload(new Uint8Array(100), "application/zip")).status, 200);
    assertEquals((await test.upload(new Uint8Array(101), "application/zip")).status, 422);
    assertEquals((await test.upload(new Uint8Array(100 + 65 * 1024), "a/b")).status, 413);
});

Deno.test("a description is at most as long as config allows", async () => {
    await using test = await open(
        MediaLimits.parse({}),
        undefined,
        Limits.parse({ media_description: 10 }),
    );
    const described = async (description: string) =>
        (await test.upload(zip, "application/zip", { description })).status;

    assertEquals(await described("x".repeat(10)), 200);
    assertEquals(await described("x".repeat(11)), 422);
});

Deno.test("uploading needs the write:media scope", async () => {
    await using test = await open();
    const form = new FormData();
    form.append("file", new File([zip], "notes.zip"));

    const reply = await test.request("POST", "/api/v2/media", { form, scopes: ["read"] });

    assertEquals(reply.status, 403);
});

Deno.test("a file that isn't a picture is served to be saved, and cached for good", async () => {
    await using test = await open();
    const { body } = await test.upload(zip, "application/zip");

    assertEquals(await test.download(body.url), {
        status: 200,
        type: "application/octet-stream",
        disposition: "attachment",
        cache: "public, max-age=31536000, immutable",
        bytes: zip,
    });
});

Deno.test("video and audio are served as what they say they are, to be played", async () => {
    await using test = await open();

    for (const type of ["video/webm", "audio/mpeg"]) {
        const bytes = new Uint8Array([...zip, ...new TextEncoder().encode(type)]);
        const { body } = await test.upload(bytes, type);

        assertEquals(body.type, type.split("/")[0]);
        assertEquals(await test.download(body.url), {
            status: 200,
            type,
            disposition: null,
            cache: "public, max-age=31536000, immutable",
            bytes,
        });
    }
});

Deno.test("a file that says it is a picture, but isn't, is offered as a file", async () => {
    await using test = await open();

    const { body } = await test.upload(zip, "image/png");

    assertEquals(body.type, "unknown");
    assertEquals((await test.download(body.url)).type, "application/octet-stream");
});

Deno.test("a picture is served once it is processed, with its preview", async () => {
    await using test = await open();
    const picture = png(40, 30);
    const { body } = await test.upload(picture, "image/png");
    const raw = `https://social.example/media/${await sha256Of(picture)}`;

    // The original upload may hold metadata, so it isn't served while it is being processed.
    assertEquals((await test.download(raw)).status, 404);

    await drain(test.ctx, queues);
    const processed = (await test.request("GET", `/api/v1/media/${body.id}`)).body;
    const original = await test.download(processed.url);
    const preview = await test.download(processed.preview_url);

    assertEquals([original.status, original.type, original.disposition], [200, "image/png", null]);
    assertEquals(original.cache, "public, max-age=31536000, immutable");
    assertEquals([preview.status, preview.type, preview.disposition], [200, "image/webp", null]);
});

Deno.test("only local files that are kept are served", async () => {
    await using test = await open();
    const key = await test.ctx.files.put(await bytesSource(zip), "application/zip");
    await createInstance(test.ctx, "b.example");
    await saveRemoteMedia(test.ctx, "b.example", null, {
        url: "https://b.example/notes.zip",
        mediaType: "application/zip",
        sha256: key,
    });
    // Even if it were marked processed, or had the key as its preview.
    await test.ctx.db.updateTable("media")
        .set({ processed_at: new Date(), preview_sha256: key })
        .where("instance_id", "is not", null)
        .execute();

    const { body } = await test.upload(png(4, 4), "image/png");
    await drain(test.ctx, queues);
    const kept = (await test.request("GET", `/api/v1/media/${body.id}`)).body.url.slice(-64);
    await test.ctx.files.delete(kept);

    for (const path of [key, "0".repeat(64), "nope", "../config.toml", kept]) {
        const missing = await test.download(`https://social.example/media/${path}`);
        assertEquals([missing.status, missing.cache], [404, "no-store"], path);
    }
});

Deno.test("files a store serves itself are at its URL, which Verso's redirects to", async () => {
    const files = { ...memoryFiles(), publicUrl: (key: string) => `https://cdn.test/${key}` };
    await using test = await open(undefined, files);
    const { body } = await test.upload(zip, "application/zip");
    const key = await sha256Of(zip);

    assertEquals(body.url, `https://cdn.test/${key}`);

    const response = await test.app.request(`/media/${key}`);
    assertEquals(response.status, 302);
    assertEquals(response.headers.get("location"), `https://cdn.test/${key}`);
    assertEquals(
        (await test.download(`https://social.example/media/${"0".repeat(64)}`)).status,
        404,
    );
});
