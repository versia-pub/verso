import { AwsClient } from "aws4fetch";
import type { Clock } from "./clock.ts";
import { checkFileKey, fileKeyOf, type FileStore } from "./files.ts";
import type { Transport } from "./transport.ts";

/** A bucket on a server that speaks S3, such as AWS, Garage, MinIO or Cloudflare R2. */
export type S3Bucket = {
    /** The server's URL, such as `https://s3.eu-west-1.amazonaws.com`. */
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    /** What objects' names start with, such as `verso/media`, if the bucket is shared. */
    readonly prefix?: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Where the bucket's files are public, such as a CDN, each at `<publicUrl>/<key>`. */
    readonly publicUrl?: string;
};

/** Files kept under their hash never change, so anything serving them may cache them for good. */
const cacheControl = "public, max-age=31536000, immutable";

/** What `check` writes, then removes. It isn't a file key, so no file can be kept under it. */
const checkName = "verso-check";

/**
 * Keeps files in an S3 bucket, each object named by its key, with requests signed with AWS
 * Signature Version 4 and sent through `transport`. Buckets are named in the path, which every S3
 * server understands, rather than in the hostname.
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */
export const s3Files = (bucket: S3Bucket, transport: Transport, clock: Clock): FileStore => {
    const client = new AwsClient({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        service: "s3",
        region: bucket.region,
    });
    const base = [bucket.endpoint.replace(/\/$/, ""), bucket.bucket, bucket.prefix]
        .filter((part) => part !== undefined).join("/");

    /** Sends `method` for the object `name`, signed as of now. */
    const send = async (method: string, name: string, init: RequestInit = {}) => {
        const datetime = clock.now().toISOString().replace(/[:-]|\.\d{3}/g, "");
        return await transport(
            await client.sign(`${base}/${name}`, { ...init, method, aws: { datetime } }),
        );
    };

    /** An error saying what the server answered to `method` for `name`. */
    const failure = async (response: Response, method: string, name: string) => {
        const said = (await response.text()).slice(0, 500);
        return new Error(`S3 answered ${response.status} to ${method} ${name}: ${said}`);
    };

    /** Puts `bytes` as `name`, whose SHA-256 they have, so the server checks they arrived whole. */
    const put = async (
        name: string,
        bytes: Uint8Array<ArrayBuffer>,
        sha256: string,
        type: string,
    ) => {
        const response = await send("PUT", name, {
            body: bytes,
            headers: {
                "content-type": type,
                "cache-control": cacheControl,
                // Served from the bucket, a file that may not be shown is saved, as Verso serves it.
                ...type === "application/octet-stream" && { "content-disposition": "attachment" },
                "x-amz-content-sha256": sha256,
            },
        });
        if (!response.ok) throw await failure(response, "PUT", name);
        await response.body?.cancel();
    };

    /** Removes `name`. One that isn't there counts as removed: S3 answers 204, some servers 404. */
    const remove = async (name: string) => {
        const response = await send("DELETE", name);
        if (!response.ok && response.status !== 404) {
            throw await failure(response, "DELETE", name);
        }
        await response.body?.cancel();
    };

    const publicUrl = bucket.publicUrl?.replace(/\/$/, "");

    return {
        ...publicUrl !== undefined && { publicUrl: (key: string) => `${publicUrl}/${key}` },
        // S3 needs the body's length, which a streamed body doesn't say, so the file is read whole.
        put: async (file, mediaType) => {
            checkFileKey(file.sha256);
            const bytes = await new Response(await file.open()).bytes();
            await put(file.sha256, bytes, file.sha256, mediaType);
            return file.sha256;
        },
        has: async (key) => {
            checkFileKey(key);
            const response = await send("HEAD", key);
            if (!response.ok && response.status !== 404) {
                throw await failure(response, "HEAD", key);
            }

            await response.body?.cancel();
            return response.ok;
        },
        get: async (key) => {
            checkFileKey(key);
            const response = await send("GET", key);
            if (response.status === 404) {
                await response.body?.cancel();
                return undefined;
            }

            if (!response.ok) throw await failure(response, "GET", key);
            return response.body ?? ReadableStream.from([]);
        },
        delete: async (key) => {
            checkFileKey(key);
            await remove(key);
        },
        check: async () => {
            const empty = new Uint8Array();
            await put(checkName, empty, await fileKeyOf(empty), "application/octet-stream");
            await remove(checkName);
        },
    };
};
