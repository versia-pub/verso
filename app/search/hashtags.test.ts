import { assertEquals } from "@std/assert";
import type { Visibility } from "../accounts/tables.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { type HashtagSearch, searchHashtags } from "./hashtags.ts";

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");

    const post = (visibility: Visibility, tags: string[]) =>
        createNote(test.ctx, "alice", { visibility }, [], tags);

    const find = (query: string, search: Partial<HashtagSearch> = {}) =>
        searchHashtags(test.ctx, { query, limit: 40, offset: 0, ...search });

    return { ...test, post, find };
};

Deno.test("hashtags are found by their start, shortest first, each once", async () => {
    await using test = await open();
    await test.post("public", ["versioning", "verso"]);
    await test.post("public", ["verso", "ver"]);
    await test.post("unlisted", ["versia"]);
    await test.post("public", ["verb", "vera", "other"]);

    assertEquals(await test.find("ver"), ["ver", "vera", "verb", "verso", "versia", "versioning"]);
    assertEquals(await test.find(" #VERS "), ["verso", "versia", "versioning"]);
    assertEquals(await test.find("ver", { limit: 2, offset: 2 }), ["verb", "verso"]);
    assertEquals(await test.find("erso"), []);
    assertEquals(await test.find("#"), []);
});

Deno.test("hashtags used only in private or direct statuses aren't found", async () => {
    await using test = await open();
    await test.post("private", ["secret", "shared"]);
    await test.post("direct", ["secretive"]);
    await test.post("public", ["shared"]);

    assertEquals(await test.find("s"), ["shared"]);
});

Deno.test("a query's _ and % are themselves", async () => {
    await using test = await open();
    await test.post("public", ["a_b", "axb", "a%b", "a\\b"]);

    assertEquals(await test.find("a_"), ["a_b"]);
    assertEquals(await test.find("a%"), ["a%b"]);
    assertEquals(await test.find("a\\"), ["a\\b"]);
});
