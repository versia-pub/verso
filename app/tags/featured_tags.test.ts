import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Visibility } from "../kernel/visibility.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { featuredTagLimit, featureTag } from "./featured_tags.ts";
import { tagRoutes } from "./routes.ts";
import { displayNamesOf } from "./tag_queries.ts";

/** alice and bob, and the remote carol. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, tagRoutes, { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");

    /** Sends a request as `as`, or as nobody if it is `null`. */
    const request = async (
        method: string,
        path: string,
        options: { as?: string | null; body?: unknown } = {},
    ) => {
        const as = options.as === undefined ? "alice" : options.as;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (as !== null) headers.authorization = `Bearer ${await tokenFor(test.ctx, as)}`;

        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const response = await app.request(path, { method, headers, body });
        return { status: response.status, body: await response.json() };
    };

    /** A status by `accountId` with the hashtags `tags`. */
    const tagged = (accountId: string, tags: string[], visibility: Visibility = "public") =>
        createNote(test.ctx, accountId, { visibility }, [], tags);

    return { ...test, request, tagged };
};

Deno.test("a user features hashtags, which are counted from their statuses anyone may see", async () => {
    await using test = await open();
    await test.tagged("alice", ["cats"]);
    test.clock.advance(24 * 60 * 60 * 1000);
    await test.tagged("alice", ["cats", "dogs"], "unlisted");
    await test.tagged("alice", ["cats"], "private");
    await test.tagged("bob", ["cats"]);

    const cats = await test.request("POST", "/api/v1/featured_tags", { body: { name: "#Cats" } });
    assertEquals(cats.status, 200);
    assertEquals(
        [cats.body.name, cats.body.statuses_count, cats.body.last_status_at],
        ["Cats", "2", "2026-01-02"],
    );

    // Featuring it again, in any case, gives it back.
    const again = await test.request("POST", "/api/v1/featured_tags", { body: { name: "cats" } });
    assertEquals(again.body.id, cats.body.id);

    // A hashtag no status has used becomes known.
    await test.request("POST", "/api/v1/featured_tags", { body: { name: "Birds" } });
    assertEquals(await displayNamesOf(test.ctx, ["birds"]), new Map([["birds", "Birds"]]));
    const own = await test.request("GET", "/api/v1/featured_tags");
    assertEquals(
        own.body.map((tag: { name: string; statuses_count: string; last_status_at: string }) => [
            tag.name,
            tag.statuses_count,
            tag.last_status_at,
        ]),
        [["Cats", "2", "2026-01-02"], ["Birds", "0", null]],
    );

    // Anyone sees them, in the order they were featured.
    const listed = await test.request("GET", "/api/v1/accounts/alice/featured_tags", { as: null });
    assertEquals(listed.body.map((tag: { name: string }) => tag.name), ["Cats", "Birds"]);
    assertEquals((await test.request("GET", "/api/v1/accounts/carol/featured_tags")).body, []);
    assertEquals((await test.request("GET", "/api/v1/accounts/missing/featured_tags")).status, 404);
});

Deno.test("a featured hashtag must be a hashtag, and a user features at most 10", async () => {
    await using test = await open();
    for (const name of ["", "123", "two words", "#"]) {
        const featured = await test.request("POST", "/api/v1/featured_tags", { body: { name } });
        assertEquals(featured.status, 422, name);
    }

    for (let i = 0; i < featuredTagLimit; i++) await featureTag(test.ctx, "alice", `tag${i}`);
    const full = await test.request("POST", "/api/v1/featured_tags", { body: { name: "more" } });
    assertEquals(full.status, 422);
    // Bob's don't count.
    assertEquals(
        (await test.request("POST", "/api/v1/featured_tags", { as: "bob", body: { name: "more" } }))
            .status,
        200,
    );
});

Deno.test("a user stops featuring a hashtag, but not another user's", async () => {
    await using test = await open();
    const featured = await featureTag(test.ctx, "alice", "cats");
    const id = typeof featured === "string" ? "" : featured.id;

    assertEquals(
        (await test.request("DELETE", `/api/v1/featured_tags/${id}`, { as: "bob" })).status,
        404,
    );
    assertEquals((await test.request("DELETE", `/api/v1/featured_tags/${id}`)).body, {});
    assertEquals((await test.request("GET", "/api/v1/featured_tags")).body, []);
    assertEquals((await test.request("DELETE", `/api/v1/featured_tags/${id}`)).status, 404);
});

Deno.test("suggestions are the hashtags a user used lately, the most used first, unless featured", async () => {
    await using test = await open();
    await test.tagged("alice", ["cats", "dogs"]);
    await test.tagged("alice", ["dogs"], "private");
    await test.tagged("alice", ["birds", "dogs"]);
    await test.tagged("bob", ["fish"]);
    await featureTag(test.ctx, "alice", "Birds");

    const suggested = await test.request("GET", "/api/v1/featured_tags/suggestions");
    assertEquals(suggested.body.map((tag: { name: string }) => tag.name), ["dogs", "cats"]);
});
