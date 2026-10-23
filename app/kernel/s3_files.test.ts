import { assertEquals, assertRejects } from "@std/assert";
import { fakeBucket, fakeS3 } from "../testing/fake_s3.ts";
import { fakeClock } from "./clock.ts";
import { fakeTransport } from "./fake_transport.ts";
import { fileKeyOf } from "./files.ts";
import { s3Files } from "./s3_files.ts";

const bytes = new TextEncoder().encode("Hello");

/** A store in the fake bucket, as of 2026-01-01, with `bucket` changing what it is told. */
const open = (bucket: Partial<typeof fakeBucket> = {}) => {
    const s3 = fakeS3();
    const transport = fakeTransport({ "s3.test": s3 });
    const store = s3Files({ ...fakeBucket, ...bucket }, transport, fakeClock());
    return { s3, transport, store };
};

Deno.test("a file is an object named by its key, with its type, put signed", async () => {
    const { s3, transport, store } = open();
    const key = await store.put(bytes, "image/png");

    assertEquals([...s3.objects.keys()], [key]);
    assertEquals(s3.objects.get(key)?.type, "image/png");

    const [put] = transport.sent;
    assertEquals([put.method, put.url], ["PUT", `https://s3.test/media/${key}`]);
    assertEquals(put.headers.get("x-amz-content-sha256"), key);
    assertEquals(put.headers.get("x-amz-date"), "20260101T000000Z");
    const authorization = put.headers.get("authorization") ?? "";
    assertEquals(
        authorization.split(", ")[0],
        "AWS4-HMAC-SHA256 Credential=GK0123/20260101/garage/s3/aws4_request",
    );
    assertEquals(
        authorization.split(", ")[1],
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    );
});

Deno.test("an endpoint with a path or a trailing slash has the bucket after it", async () => {
    for (
        const [endpoint, url] of [
            ["https://s3.test/", "https://s3.test/media/"],
            ["https://s3.test/storage/v1", "https://s3.test/storage/v1/media/"],
            ["https://s3.test/storage/v1/", "https://s3.test/storage/v1/media/"],
        ]
    ) {
        const { transport, store } = open({ endpoint });
        await store.delete(await fileKeyOf(bytes)).catch(() => {});
        assertEquals(transport.sent[0].url, `${url}${await fileKeyOf(bytes)}`, endpoint);
    }
});

Deno.test("with a prefix, every object's name starts with it, the check's too", async () => {
    const { s3, transport, store } = open({ prefix: "verso/media" });
    const key = await store.put(bytes, "text/plain");
    await store.check();

    assertEquals([...s3.objects.keys()], [`verso/media/${key}`]);
    assertEquals(await new Response(await store.get(key)).text(), "Hello");
    assertEquals(transport.sent.map((request) => new URL(request.url).pathname), [
        `/media/verso/media/${key}`,
        "/media/verso/media/verso-check",
        "/media/verso/media/verso-check",
        `/media/verso/media/${key}`,
    ]);
});

Deno.test("what the server refuses is an error saying what it answered", async () => {
    const { store, s3 } = open({ accessKeyId: "wrong" });
    const key = await fileKeyOf(bytes);

    const error = await assertRejects(() => store.put(bytes, "text/plain"), Error);
    assertEquals(
        error.message,
        `S3 answered 403 to PUT ${key}: <Error><Code>SignatureDoesNotMatch</Code></Error>`,
    );
    await assertRejects(() => store.get(key), Error, "S3 answered 403 to GET");
    await assertRejects(() => store.delete(key), Error, "S3 answered 403 to DELETE");
    assertEquals(s3.objects.size, 0);

    // A server that answers a missing object's removal with 404 has still removed it.
    const { store: other, transport } = open();
    transport.servers.set("s3.test", () => new Response("Not here", { status: 404 }));
    await other.delete(key);

    // Only so much of what a server says is kept, in case it's a whole page.
    transport.servers.set("s3.test", () => new Response("a".repeat(600), { status: 502 }));
    const long = await assertRejects(() => other.get(key), Error);
    assertEquals(long.message, `S3 answered 502 to GET ${key}: ${"a".repeat(500)}`);
});

Deno.test("what a server answers to a put or removal is let go of, so its connection is", async () => {
    const { store, transport } = open();
    let cancelled = 0;
    transport.servers.set("s3.test", () =>
        new Response(
            new ReadableStream({
                cancel: () => {
                    cancelled++;
                },
            }),
            { status: 200 },
        ));

    await store.put(bytes, "text/plain");
    await store.delete(await fileKeyOf(bytes));
    assertEquals(cancelled, 2);
});

Deno.test("a server that can't be reached is an error", async () => {
    const { store, transport } = open();
    transport.down.add("s3.test");

    await assertRejects(() => store.put(bytes, "text/plain"), TypeError, "Can't reach s3.test");
    await assertRejects(() => store.check(), TypeError, "Can't reach s3.test");
});

Deno.test("checking a bucket puts an object and removes it, and fails if it can't", async () => {
    const { store, s3, transport } = open();
    await store.check();

    assertEquals(transport.sent.map((request) => [request.method, request.url]), [
        ["PUT", "https://s3.test/media/verso-check"],
        ["DELETE", "https://s3.test/media/verso-check"],
    ]);
    assertEquals(s3.objects.size, 0);

    await assertRejects(() => open({ accessKeyId: "wrong" }).store.check(), Error, "403 to PUT");
    await assertRejects(
        () => open({ secretAccessKey: "wrong" }).store.check(),
        Error,
        "SignatureDoesNotMatch",
    );

    // One that can put but not remove isn't one Verso can use either.
    const { store: other, transport: refusing } = open();
    refusing.servers.set(
        "s3.test",
        (request) =>
            request.method === "DELETE"
                ? new Response("No", { status: 403 })
                : new Response(null, { status: 200 }),
    );
    await assertRejects(() => other.check(), Error, "S3 answered 403 to DELETE verso-check: No");
});
