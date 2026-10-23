import { AwsV4Signer } from "aws4fetch";
import type { Server } from "../kernel/fake_transport.ts";
import type { S3Bucket } from "../kernel/s3_files.ts";

/** The bucket a fake S3 server has, at `s3.test`. */
export const fakeBucket: S3Bucket = {
    endpoint: "https://s3.test",
    region: "garage",
    bucket: "media",
    accessKeyId: "GK0123",
    secretAccessKey: "secret",
};

export type FakeS3 = Server & {
    /** The objects in the bucket, by name, with their content types. */
    readonly objects: Map<string, { bytes: Uint8Array; type: string | null }>;
};

/**
 * Whether `request` is signed with the bucket's key, as of its `x-amz-date`. The signature is
 * worked out as aws4fetch works it out, so this checks what it was given, not how it signs.
 */
const signed = async (request: Request) => {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    const expected = await new AwsV4Signer({
        method: request.method,
        url: request.url,
        headers,
        accessKeyId: fakeBucket.accessKeyId,
        secretAccessKey: fakeBucket.secretAccessKey,
        service: "s3",
        region: fakeBucket.region,
        datetime: headers.get("x-amz-date") ?? "",
    }).authHeader();

    return request.headers.get("authorization") === expected;
};

/**
 * Answers as an S3 server would for `fakeBucket`, keeping objects in memory. Like S3, it checks
 * that a request is signed with the bucket's key, and that a body's `x-amz-content-sha256` is its
 * SHA-256.
 */
export const fakeS3 = (): FakeS3 => {
    const objects: FakeS3["objects"] = new Map();
    const prefix = `/${fakeBucket.bucket}/`;

    const server = async (request: Request) => {
        const { pathname } = new URL(request.url);
        if (!await signed(request)) {
            return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", {
                status: 403,
            });
        }
        if (!pathname.startsWith(prefix)) {
            return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
        }

        const name = pathname.slice(prefix.length);
        const object = objects.get(name);
        const missing = () =>
            new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });

        switch (request.method) {
            case "PUT": {
                const bytes = new Uint8Array(await request.arrayBuffer());
                const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
                if (request.headers.get("x-amz-content-sha256") !== sha256) {
                    return new Response("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", {
                        status: 400,
                    });
                }

                objects.set(name, { bytes, type: request.headers.get("content-type") });
                return new Response(null, { status: 200 });
            }
            case "GET":
                return object ? new Response(object.bytes.slice()) : missing();
            case "DELETE":
                objects.delete(name);
                return new Response(null, { status: 204 });
            default:
                return new Response(null, { status: 405 });
        }
    };

    return Object.assign(server, { objects });
};
