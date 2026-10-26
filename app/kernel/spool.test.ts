import { assertEquals, assertRejects } from "@std/assert";
import { fileKeyOf } from "./files.ts";
import { spool } from "./spool.ts";

Deno.test("a stream is written to a file, and hashed, as it is read", async () => {
    const parts = [new TextEncoder().encode("Hel"), new TextEncoder().encode("lo")];
    const whole = new TextEncoder().encode("Hello");

    let path;
    {
        await using file = await spool(ReadableStream.from(parts));
        path = file.path;

        assertEquals([file.size, file.sha256], [5, await fileKeyOf(whole)]);
        assertEquals(await Deno.readFile(path), whole);
        // It can be read again, from the start.
        assertEquals(await new Response(await file.open()).bytes(), whole);
        assertEquals(await new Response(await file.open()).bytes(), whole);
    }

    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
});

Deno.test("a stream that fails leaves no file behind", async () => {
    const directory = await Deno.makeTempDir();
    try {
        const failing = new ReadableStream({
            pull: (controller) => controller.error(new Error("Connection lost")),
        });

        await assertRejects(() => spool(failing, directory), Error, "Connection lost");

        assertEquals(await Array.fromAsync(Deno.readDir(directory)), []);
    } finally {
        await Deno.remove(directory, { recursive: true });
    }
});
