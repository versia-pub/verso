import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { tagRoutes } from "./routes.ts";
import { followTag } from "./tag_follows.ts";
import { displayNamesOf } from "./tag_queries.ts";

/** alice and bob. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, tagRoutes, { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    /** Sends a request as `as`, or as nobody if it is `null`. */
    const request = async (method: string, path: string, as: string | null = "alice") => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await app.request(path, { method, headers });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    return { ...test, request };
};

Deno.test("a hashtag is shown to anyone, and whether they follow it to a signed-in viewer", async () => {
    await using test = await open();
    await createNote(test.ctx, "bob", {}, [], ["Cats"]);
    await followTag(test.ctx, "alice", "cats");

    const followed = await test.request("GET", "/api/v1/tags/CATS");
    assertEquals(followed.status, 200);
    assertEquals([followed.body.id, followed.body.name, followed.body.following], [
        "cats",
        "Cats",
        true,
    ]);
    assertEquals(followed.body.history[0].uses, "1");

    assertEquals((await test.request("GET", "/api/v1/tags/cats", "bob")).body.following, false);
    assertEquals((await test.request("GET", "/api/v1/tags/cats", null)).body.following, undefined);
});

Deno.test("a hashtag no one used is shown as it was asked for, and one that isn't is not found", async () => {
    await using test = await open();

    const unused = await test.request("GET", "/api/v1/tags/Birds", null);
    assertEquals([unused.status, unused.body.id, unused.body.name], [200, "birds", "Birds"]);
    assertEquals(await displayNamesOf(test.ctx, ["birds"]), new Map());

    assertEquals((await test.request("GET", "/api/v1/tags/no-way", null)).status, 404);
    assertEquals((await test.request("POST", "/api/v1/tags/no-way/follow")).status, 404);
    assertEquals((await test.request("POST", "/api/v1/tags/no-way/unfollow")).status, 404);
});

Deno.test("following a hashtag, again or in any case, follows it once, until unfollowed", async () => {
    await using test = await open();

    const followed = await test.request("POST", "/api/v1/tags/Birds/follow");
    assertEquals([followed.status, followed.body.name, followed.body.following], [
        200,
        "Birds",
        true,
    ]);
    // No status has used it yet, so following it made it known, as it was written.
    assertEquals(await displayNamesOf(test.ctx, ["birds"]), new Map([["birds", "Birds"]]));
    assertEquals((await test.request("POST", "/api/v1/tags/birds/follow")).body.following, true);
    assertEquals((await test.request("GET", "/api/v1/followed_tags")).body.length, 1);

    const unfollowed = await test.request("POST", "/api/v1/tags/BIRDS/unfollow");
    assertEquals([unfollowed.status, unfollowed.body.following], [200, false]);
    assertEquals((await test.request("POST", "/api/v1/tags/birds/unfollow")).status, 200);
    assertEquals((await test.request("POST", "/api/v1/tags/birds/follow", null)).status, 401);
});

Deno.test("the hashtags a user follows are listed, the latest followed first, in pages", async () => {
    await using test = await open();
    for (const name of ["cats", "dogs", "birds"]) await followTag(test.ctx, "alice", name);
    await followTag(test.ctx, "bob", "fish");

    const all = await test.request("GET", "/api/v1/followed_tags");
    assertEquals(all.body.map((tag: { name: string }) => tag.name), ["birds", "dogs", "cats"]);
    assertEquals(all.body[0].following, true);

    const first = await test.request("GET", "/api/v1/followed_tags?limit=2");
    assertEquals(first.body.map((tag: { name: string }) => tag.name), ["birds", "dogs"]);
    const next = new URL(first.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    const second = await test.request("GET", next.pathname + next.search);
    assertEquals(second.body.map((tag: { name: string }) => tag.name), ["cats"]);

    assertEquals((await test.request("GET", "/api/v1/followed_tags", null)).status, 401);
});
