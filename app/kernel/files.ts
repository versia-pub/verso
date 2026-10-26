/** A file to store, which can be read from the start as often as needed. */
export type FileSource = {
    /** In bytes. */
    readonly size: number;
    /** Its SHA-256, in lowercase hex, which it is stored under. */
    readonly sha256: string;
    /** Its bytes, from the start. */
    readonly open: () => Promise<ReadableStream<Uint8Array>>;
};

/** `bytes`, as a file to store. */
export const bytesSource = async (bytes: Uint8Array<ArrayBuffer>): Promise<FileSource> => ({
    size: bytes.length,
    sha256: await fileKeyOf(bytes),
    open: () => Promise.resolve(ReadableStream.from([bytes])),
});

/**
 * Where uploaded files are stored, each under the SHA-256 of its bytes, so identical files are
 * stored once.
 */
export type FileStore = {
    /** Stores `file`, unless the same file is already stored, and resolves with its key. */
    readonly put: (file: FileSource, mediaType: string) => Promise<string>;
    /** Whether a file is stored under `key`, without reading it. */
    readonly has: (key: string) => Promise<boolean>;
    /** The file stored under `key`, or `undefined` if there is none. */
    readonly get: (key: string) => Promise<ReadableStream<Uint8Array> | undefined>;
    /**
     * Removes the file stored under `key`, if there is one. Identical uploads share it, so only
     * remove it once nothing refers to its key.
     */
    readonly delete: (key: string) => Promise<void>;
    /**
     * Throws unless Verso can store files there, so a store it can't use stops Verso when it starts
     * rather than at the first upload.
     */
    readonly check: () => Promise<void>;
    /**
     * Where anyone may fetch the file stored under `key`, for a store that serves its files itself,
     * such as a bucket behind a CDN. Without it, Verso serves them.
     */
    readonly publicUrl?: (key: string) => string;
};

/** Whether `key` is one a file could be stored under: a SHA-256, in lowercase hex. */
export const isFileKey = (key: string): boolean => /^[0-9a-f]{64}$/.test(key);

/** Throws unless `key` is a file key, so that no key can name a path outside the store. */
export const checkFileKey = (key: string): void => {
    if (!isFileKey(key)) throw new TypeError(`${JSON.stringify(key)} isn't a file key`);
};

/** The key `bytes` are stored under. */
export const fileKeyOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

/** Stores files in memory, for tests. */
export const memoryFiles = (): FileStore => {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();

    return {
        put: async (file) => {
            if (!files.has(file.sha256)) {
                files.set(file.sha256, await new Response(await file.open()).bytes());
            }
            return file.sha256;
        },
        has: (key) =>
            Promise.try(() => {
                checkFileKey(key);
                return files.has(key);
            }),
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
