import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { type PageBounds, readPage } from "./paging.ts";

Deno.test("a page is read by its cursor, newest first, as Mastodon pages", async () => {
    await using test = await createTestContext();
    for (const id of ["a", "b", "c", "d", "e"]) await createLocalAccount(test.ctx, id);

    const read = async (page: Partial<PageBounds>) =>
        (await readPage(
            test.ctx.db.selectFrom("accounts").select("id"),
            "accounts.id",
            { limit: 2, ...page },
        )).map((row) => row.id);

    assertEquals(await read({}), ["e", "d"]);
    assertEquals(await read({ limit: 10 }), ["e", "d", "c", "b", "a"]);
    assertEquals(await read({ max_id: "d" }), ["c", "b"]);
    // Just newer than `b`, rather than the newest that are.
    assertEquals(await read({ min_id: "b" }), ["d", "c"]);
    assertEquals(await read({ since_id: "b" }), ["e", "d"]);
    assertEquals(await read({ since_id: "b", limit: 10 }), ["e", "d", "c"]);
    assertEquals(await read({ max_id: "e", since_id: "b" }), ["d", "c"]);
    assertEquals(await read({ max_id: "e", min_id: "a", limit: 10 }), ["d", "c", "b"]);
    assertEquals(await read({ max_id: "a" }), []);
});
