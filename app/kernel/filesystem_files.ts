import { checkFileKey, fileKeyOf, type FileStore } from "./files.ts";

/** Where in `root` the file kept under `key` is: in a directory named for its first two digits. */
const pathOf = (root: string, key: string) => `${root}/${key.slice(0, 2)}/${key}`;

/** Where in `root` files are written before they are moved into place. */
const tempOf = (root: string) => `${root}/tmp`;

/** Whether `path` is there. If Verso can't tell, writing it will fail and say why. */
const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

/**
 * Makes `root` if it isn't there, and checks Verso can write to it, so a store it can't use stops
 * Verso when it starts rather than at the first upload.
 */
export const prepareFilesystemFiles = async (root: string): Promise<void> => {
    await Deno.mkdir(tempOf(root), { recursive: true });
    await Deno.remove(await Deno.makeTempFile({ dir: tempOf(root) }));
};

/**
 * Keeps files in the directory `root`. Each is written to a file of its own inside it, then moved
 * into place, so a file is either all there or not there at all. Moving it within `root` keeps it
 * on one filesystem, which moving it from the system's temporary directory might not.
 */
export const filesystemFiles = (root: string): FileStore => ({
    put: async (bytes) => {
        const key = await fileKeyOf(bytes);
        const path = pathOf(root, key);
        if (await exists(path)) return key;

        await Deno.mkdir(tempOf(root), { recursive: true });
        await Deno.mkdir(`${root}/${key.slice(0, 2)}`, { recursive: true });
        const temp = await Deno.makeTempFile({ dir: tempOf(root) });
        try {
            await Deno.writeFile(temp, bytes);
            await Deno.rename(temp, path);
        } catch (error) {
            await Deno.remove(temp).catch(() => {});
            throw error;
        }

        return key;
    },
    get: async (key) => {
        checkFileKey(key);
        try {
            return (await Deno.open(pathOf(root, key))).readable;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return undefined;
            throw error;
        }
    },
    delete: async (key) => {
        checkFileKey(key);
        try {
            await Deno.remove(pathOf(root, key));
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    },
});
