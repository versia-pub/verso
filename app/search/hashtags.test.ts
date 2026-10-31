import { assertEquals } from "@std/assert";
import type { Visibility } from "../kernel/visibility.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { type HashtagSearch, renderHashtags, searchHashtags } from "./hashtags.ts";

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

Deno.test("a query's wildcards are themselves", async () => {
    await using test = await open();
    await test.post("public", ["a_b", "axb", "a%b", "a\\b", "a*b", "a?b", "a[b]", "a]b"]);

    for (const tag of ["a_b", "a%b", "a\\b", "a*b", "a?b", "a[b]", "a]b"]) {
        assertEquals(await test.find(tag.slice(0, 2)), [tag], tag);
    }
});

Deno.test("a hashtag shows how public and unlisted statuses used it each day of the past week", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    const post = (
        at: string,
        tags: string[],
        accountId = "alice",
        visibility: Visibility = "public",
    ) => createNote(test.ctx, accountId, { visibility, created_at: new Date(at) }, [], tags);
    const arrive = (at: string) => test.clock.advance(Date.parse(at) - test.clock.now().getTime());

    // Dated in the week, but arrived before it started, as remote statuses can be.
    await post("2026-01-08T09:00:00Z", ["verso"], "bob");
    arrive("2026-01-02T00:00:00Z");
    await post("2026-01-02T00:00:00Z", ["verso"]);
    arrive("2026-01-08T12:00:00Z");
    await post("2026-01-08T11:00:00Z", ["verso", "versia"]);
    await post("2026-01-08T00:00:00Z", ["verso"]);
    await post("2026-01-08T10:00:00Z", ["verso"], "bob", "unlisted");
    await post("2026-01-08T10:00:00Z", ["verso"], "bob", "private");
    await post("2026-01-07T23:59:59Z", ["verso"]);
    // Too long ago, or not yet.
    await post("2026-01-01T23:59:59Z", ["verso", "old"]);
    await post("2026-01-09T00:00:00Z", ["verso"]);

    /** The past week's days, today first, with uses and accounts for those used. */
    const history = (used: Record<number, [number, number]>) =>
        Array.from({ length: 7 }, (_, i) => ({
            day: String(Date.UTC(2026, 0, 8 - i) / 1000),
            uses: String(used[i]?.[0] ?? 0),
            accounts: String(used[i]?.[1] ?? 0),
        }));
    assertEquals(await renderHashtags(test.ctx, ["verso", "versia", "old"], null), [
        {
            id: "verso",
            name: "verso",
            url: "https://social.example/tags/verso",
            history: history({ 0: [3, 2], 1: [1, 1], 6: [1, 1] }),
        },
        {
            id: "versia",
            name: "versia",
            url: "https://social.example/tags/versia",
            history: history({ 0: [1, 1] }),
        },
        {
            id: "old",
            name: "old",
            url: "https://social.example/tags/old",
            history: history({}),
        },
    ]);
    assertEquals(await renderHashtags(test.ctx, [], null), []);
});
