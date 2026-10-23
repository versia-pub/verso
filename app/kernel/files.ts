/**
 * Where uploaded files are kept, each under the SHA-256 of its bytes, so identical files are kept
 * once.
 */
export type FileStore = {
    /** Keeps `bytes`, unless the same file is kept already, and resolves with its key. */
    readonly put: (bytes: Uint8Array<ArrayBuffer>, mediaType: string) => Promise<string>;
    /** The file kept under `key`, or `undefined` if there is none. */
    readonly get: (key: string) => Promise<ReadableStream<Uint8Array> | undefined>;
    /**
     * Removes the file kept under `key`, if there is one. Identical uploads share it, so only
     * remove it once nothing refers to its key.
     */
    readonly delete: (key: string) => Promise<void>;
    /**
     * Throws unless Verso can keep files there, so a store it can't use stops Verso when it
     * starts rather than at the first upload.
     */
    readonly check: () => Promise<void>;
};

/** Whether `key` is one a file could be kept under: a SHA-256, in lowercase hex. */
export const isFileKey = (key: string): boolean => /^[0-9a-f]{64}$/.test(key);

/** Throws unless `key` is a file key, so that no key can name a path outside the store. */
export const checkFileKey = (key: string): void => {
    if (!isFileKey(key)) throw new TypeError(`${JSON.stringify(key)} isn't a file key`);
};

/** The key `bytes` are kept under. */
export const fileKeyOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

/** Keeps files in memory, for tests. */
export const memoryFiles = (): FileStore => {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();

    return {
        put: async (bytes) => {
            const key = await fileKeyOf(bytes);
            if (!files.has(key)) files.set(key, bytes.slice());
            return key;
        },
        get: (key) =>
            Promise.try(() => {
                checkFileKey(key);
                const bytes = files.get(key);
                return bytes && ReadableStream.from([bytes.slice()]);
            }),
        delete: (key) =>
            Promise.try(() => {
                checkFileKey(key);
                files.delete(key);
            }),
        check: () => Promise.resolve(),
    };
};
