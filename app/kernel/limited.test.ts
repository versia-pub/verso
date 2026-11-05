import { assertEquals } from "@std/assert";
import { readLimited } from "./limited.ts";

/** A stream of `chunks`, which records whether it was cancelled. */
const streamOf = (chunks: number[][]) => {
    const state = { cancelled: false };
    const queue = chunks.map((chunk) => new Uint8Array(chunk));
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            const next = queue.shift();
            if (next) controller.enqueue(next);
            else controller.close();
        },
        cancel() {
            state.cancelled = true;
        },
    });

    return { stream, state };
};

Deno.test("readLimited reads a body that fits whole", async () => {
    const { stream } = streamOf([[1, 2], [3]]);

    assertEquals(await readLimited(stream, 3), {
        body: new Uint8Array([1, 2, 3]),
        truncated: false,
    });
});

Deno.test("readLimited cuts a body at the limit, and cancels the stream", async () => {
    const { stream, state } = streamOf([[1, 2], [3, 4], [5]]);

    assertEquals(await readLimited(stream, 3), {
        body: new Uint8Array([1, 2, 3]),
        truncated: true,
    });
    assertEquals(state.cancelled, true);
});

Deno.test("readLimited is not truncated when the body ends exactly at the limit", async () => {
    const { stream } = streamOf([[1, 2], [3, 4]]);

    assertEquals((await readLimited(stream, 4)).truncated, false);
});

Deno.test("readLimited reads no body as empty", async () => {
    assertEquals(await readLimited(null, 10), { body: new Uint8Array(0), truncated: false });
});
