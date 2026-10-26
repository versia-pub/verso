import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { FileStore } from "./files.ts";
import { filesystemFiles } from "./filesystem_files.ts";
import { s3Files } from "./s3_files.ts";
import { timedTransport, type Transport } from "./transport.ts";

/**
 * The store `storage` names. An S3 server is one the admin chose, which may be on their network,
 * so `transport` should reach it there.
 */
export const filesFor = (
    storage: Config["media"]["storage"],
    transport: Transport,
    clock: Clock,
): FileStore =>
    "filesystem" in storage ? filesystemFiles(storage.filesystem) : s3Files(
        {
            endpoint: storage.s3.endpoint,
            region: storage.s3.region,
            bucket: storage.s3.bucket,
            prefix: storage.s3.prefix,
            accessKeyId: storage.s3.access_key_id,
            secretAccessKey: storage.s3.secret_access_key,
            publicUrl: storage.s3.public_url,
        },
        timedTransport(transport, storage.s3.timeout_seconds * 1000),
        clock,
    );
