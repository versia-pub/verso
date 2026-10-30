import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createNote } from "../notes/testing.ts";
import { renderHashtags } from "../search/hashtags.ts";
import { createTestContext } from "../testing/context.ts";
import { displayNamesOf, insertTags } from "./tag_queries.ts";

Deno.test("a hashtag is known by how it was first written", async () => {
    await using test = await createTestContext();
    await insertTags(test.ctx, ["Verso", "VERSO", "deno"]);
    await insertTags(test.ctx, ["DENO"]);

    assertEquals(
        await displayNamesOf(test.ctx, ["verso", "deno", "missing"]),
        new Map([["verso", "Verso"], ["deno", "deno"]]),
    );
});

Deno.test("a status's hashtags become known, and are shown as first written", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createNote(test.ctx, "alice", {}, [], ["VersoDev"]);
    await createNote(test.ctx, "alice", {}, [], ["versodev"]);

    const [tag] = await renderHashtags(test.ctx, ["versodev"]);
    assertEquals([tag?.id, tag?.name, tag?.url], [
        "versodev",
        "VersoDev",
        "https://social.example/tags/versodev",
    ]);
});
