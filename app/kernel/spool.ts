/**
 * Files written to disk as they are read, and hashed on the way, so that an upload is held in
 * memory as little as can be.
 * @module
 */
import { createHash } from "node:crypto";
import type { FileSource } from "./files.ts";

/** A file written to a temporary file, removed once it is disposed of. */
export type SpooledFile = FileSource & AsyncDisposable & { readonly path: string };

/** Writes `stream` to a new temporary file in `directory`, or the system's, hashing it as it goes. */
export const spool = async (
    stream: ReadableStream<Uint8Array>,
    directory?: string,
): Promise<SpooledFile> => {
    const path = await Deno.makeTempFile({ dir: directory, prefix: "verso-upload-" });
    const hash = createHash("sha256");
    let size = 0;

    try {
        const counted = stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform: (chunk, controller) => {
                    hash.update(chunk);
                    size += chunk.length;
                    controller.enqueue(chunk);
                },
            }),
        );
        await Deno.writeFile(path, counted);
    } catch (error) {
        await Deno.remove(path).catch(() => {});
        throw error;
    }

    return {
        path,
        size,
        sha256: hash.digest("hex"),
        open: async () => (await Deno.open(path)).readable,
        [Symbol.asyncDispose]: () => Deno.remove(path).catch(() => {}),
    };
};
