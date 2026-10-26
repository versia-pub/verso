import { assertEquals } from "@std/assert";
import { fakeBucket, fakeS3 } from "../testing/fake_s3.ts";
import { fakeClock } from "./clock.ts";
import { fakeTransport } from "./fake_transport.ts";
import { filesFor } from "./file_stores.ts";

const bytes = new TextEncoder().encode("Hello");

Deno.test("the configured store is the one files are kept in", async () => {
    const root = await Deno.makeTempDir();
    try {
        const key = await filesFor({ filesystem: root }, fakeTransport(), fakeClock())
            .put(bytes, "text/plain");
        assertEquals(await Deno.readFile(`${root}/${key.slice(0, 2)}/${key}`), bytes);
    } finally {
        await Deno.remove(root, { recursive: true });
    }

    const s3 = fakeS3();
    const transport = fakeTransport({ "s3.test": s3 });
    const store = filesFor(
        {
            s3: {
                endpoint: fakeBucket.endpoint,
                region: fakeBucket.region,
                bucket: fakeBucket.bucket,
                prefix: "verso",
                access_key_id: fakeBucket.accessKeyId,
                secret_access_key: fakeBucket.secretAccessKey,
                public_url: "https://cdn.test",
                timeout_seconds: 120,
            },
        },
        transport,
        fakeClock(),
    );
    const key = await store.put(bytes, "text/plain");

    assertEquals([...s3.objects.keys()], [`verso/${key}`]);
    assertEquals(store.publicUrl?.(key), `https://cdn.test/${key}`);
    assertEquals(
        transport.sent[0].headers.get("authorization")?.split(", ")[0],
        "AWS4-HMAC-SHA256 Credential=GK0123/20260101/garage/s3/aws4_request",
    );
});
