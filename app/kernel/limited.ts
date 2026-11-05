/**
 * Reading a body that a remote server sends, which may be of any size.
 * @module
 */

/**
 * Reads up to `limit` bytes of `stream`, and stops there. `truncated` says whether the stream had
 * more to give.
 */
export const readLimited = async (
    stream: ReadableStream<Uint8Array> | null,
    limit: number,
): Promise<{ body: Uint8Array<ArrayBuffer>; truncated: boolean }> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;

    if (stream) {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const room = limit - size;
                if (value.length > room) {
                    chunks.push(value.subarray(0, room));
                    size = limit;
                    truncated = true;
                    break;
                }

                chunks.push(value);
                size += value.length;
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
    }

    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
    }

    return { body, truncated };
};
