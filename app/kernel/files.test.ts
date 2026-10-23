import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fileKeyOf, type FileStore, isFileKey, memoryFiles } from "./files.ts";
import { filesystemFiles, prepareFilesystemFiles } from "./filesystem_files.ts";

const bytes = new TextEncoder().encode("Hello");

/** The SHA-256 of "Hello", from `printf Hello | sha256sum`. */
const helloKey = "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969";

const read = async (store: FileStore, key: string) => {
    const file = await store.get(key);
    return file && new Uint8Array(await new Response(file).arrayBuffer());
};

/** A store in a new temporary directory, removed afterwards. */
const temporary = async () => {
    const root = await Deno.makeTempDir();
    return {
        root,
        store: filesystemFiles(root),
        [Symbol.asyncDispose]: () => Deno.remove(root, { recursive: true }),
    };
};

/** What every store does, given a new, empty one. */
const contract = (name: string, open: () => Promise<FileStore & AsyncDisposable>) => {
    Deno.test(`${name}: a file is kept under the SHA-256 of its bytes, once`, async () => {
        await using store = await open();
        const key = await store.put(bytes, "text/plain");

        assertEquals(key, helloKey);
        assertEquals(await store.put(bytes.slice(), "text/plain"), key);
        assertEquals(await read(store, key), bytes);

        const other = await store.put(new TextEncoder().encode("Hello!"), "text/plain");
        assertNotEquals(other, key);
        assertEquals(await read(store, other), new TextEncoder().encode("Hello!"));
    });

    Deno.test(`${name}: a file is kept as it was put, whatever happens to its bytes`, async () => {
        await using store = await open();
        const changing = bytes.slice();
        const key = await store.put(changing, "text/plain");
        changing[0] = 0;

        // Whoever reads it gets bytes of their own.
        const chunk = (await (await store.get(key))?.getReader().read())?.value;
        assertEquals(chunk, bytes);
        if (chunk) chunk[0] = 0;
        assertEquals(await read(store, key), bytes);
    });

    Deno.test(`${name}: a file removed is gone, and removing it again does nothing`, async () => {
        await using store = await open();
        const key = await store.put(bytes, "text/plain");
        const other = await store.put(new Uint8Array([1, 2, 3]), "application/octet-stream");

        await store.delete(key);
        assertEquals(await read(store, key), undefined);
        assertEquals(await read(store, other), new Uint8Array([1, 2, 3]));
        await store.delete(key);

        assertEquals(await store.put(bytes, "text/plain"), key);
        assertEquals(await read(store, key), bytes);
    });

    Deno.test(`${name}: a key that isn't a SHA-256 in lowercase hex is refused`, async () => {
        await using store = await open();
        await store.put(bytes, "text/plain");

        for (const key of ["../" + helloKey.slice(3), helloKey.toUpperCase(), helloKey.slice(1)]) {
            await assertRejects(() => store.get(key), TypeError);
            await assertRejects(() => store.delete(key), TypeError);
        }
        assertEquals(await read(store, helloKey), bytes);
    });
};

contract("in memory", () => {
    const store = memoryFiles();
    return Promise.resolve({ ...store, [Symbol.asyncDispose]: () => Promise.resolve() });
});

contract("on the filesystem", async () => {
    const test = await temporary();
    return { ...test.store, [Symbol.asyncDispose]: test[Symbol.asyncDispose] };
});

Deno.test("a key is a SHA-256 in lowercase hex", async () => {
    assertEquals(await fileKeyOf(bytes), helloKey);
    assertEquals(isFileKey(helloKey), true);

    for (
        const key of ["", helloKey.slice(1), `${helloKey}0`, helloKey.toUpperCase(), ` ${helloKey}`]
    ) {
        assertEquals(isFileKey(key), false, key);
    }
    assertEquals(isFileKey(helloKey.replace("f", "g")), false);
});

Deno.test("on the filesystem, a file is in a directory for its first two digits, written once", async () => {
    await using test = await temporary();
    const key = await test.store.put(bytes, "text/plain");
    const path = `${test.root}/18/${key}`;
    const written = await Deno.stat(path);

    await test.store.put(bytes, "text/plain");
    assertEquals((await Deno.stat(path)).ino, written.ino);
    assertEquals(await Deno.readFile(path), bytes);

    // What was written on the way is gone.
    assertEquals(await Array.fromAsync(Deno.readDir(`${test.root}/tmp`)), []);
});

Deno.test("on the filesystem, a file that can't be moved into place leaves nothing behind", async () => {
    await using test = await temporary();
    await Deno.mkdir(`${test.root}/18`, { mode: 0o555 });

    await assertRejects(() => test.store.put(bytes, "text/plain"), Deno.errors.PermissionDenied);
    assertEquals(await Array.fromAsync(Deno.readDir(`${test.root}/tmp`)), []);
    await Deno.chmod(`${test.root}/18`, 0o755);
});

Deno.test("on the filesystem, a file that can't be removed says so", async () => {
    await using test = await temporary();
    const key = await test.store.put(bytes, "text/plain");
    await Deno.chmod(`${test.root}/18`, 0o555);

    await assertRejects(() => test.store.delete(key), Deno.errors.PermissionDenied);
    await Deno.chmod(`${test.root}/18`, 0o755);
    assertEquals(await read(test.store, key), bytes);
});

Deno.test("preparing a directory makes it, and fails if Verso can't write to it", async () => {
    await using test = await temporary();
    const root = `${test.root}/media/files`;

    await prepareFilesystemFiles(root);
    assertEquals((await Deno.stat(`${root}/tmp`)).isDirectory, true);
    assertEquals(await Array.fromAsync(Deno.readDir(`${root}/tmp`)), []);

    await Deno.writeFile(`${test.root}/file`, bytes);
    await assertRejects(() => prepareFilesystemFiles(`${test.root}/file`));

    // One that is there already is still checked.
    await Deno.chmod(`${root}/tmp`, 0o555);
    await assertRejects(() => prepareFilesystemFiles(root), Deno.errors.PermissionDenied);
    await Deno.chmod(`${root}/tmp`, 0o755);
});
