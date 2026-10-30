import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { bookmarkedAmong } from "./bookmark_queries.ts";
import { bookmarkRoutes } from "./bookmark_routes.ts";
import { bookmark } from "./bookmarks.ts";
import { createNote, createShare } from "./testing.ts";

/** alice, bob, who follows her, and dave. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, bookmarkRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    /** Sends a request as `as`, or as nobody if it is `null`. */
    const request = async (method: string, path: string, as: string | null = "bob") => {
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

Deno.test("bookmarking a status gives it back bookmarked, for the viewer alone", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}`;

    const bookmarked = await test.request("POST", `${path}/bookmark`);
    assertEquals([bookmarked.status, bookmarked.body.bookmarked], [200, true]);
    assertEquals((await test.request("POST", `${path}/bookmark`)).body.bookmarked, true);
    assertEquals((await bookmarkedAmong(test.ctx, "dave", [note.id])).size, 0);

    const undone = await test.request("POST", `${path}/unbookmark`);
    assertEquals([undone.status, undone.body.bookmarked], [200, false]);
    assertEquals((await test.request("POST", `${path}/unbookmark`)).status, 200);
});

Deno.test("bookmarking a boost bookmarks the status it boosts", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const boost = await createShare(test.ctx, "dave", note.id);

    const bookmarked = await test.request("POST", `/api/v1/statuses/${boost.id}/bookmark`);
    assertEquals([bookmarked.body.id, bookmarked.body.bookmarked], [note.id, true]);

    const undone = await test.request("POST", `/api/v1/statuses/${boost.id}/unbookmark`);
    assertEquals([undone.body.id, undone.body.bookmarked], [note.id, false]);
});

Deno.test("a status the viewer can't see can't be bookmarked, but a bookmark of it can be removed", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("POST", `${path}/bookmark`, "dave")).status, 404);
    assertEquals((await test.request("POST", `${path}/unbookmark`, "dave")).status, 404);
    assertEquals((await test.request("POST", `${path}/bookmark`, null)).status, 401);
    assertEquals((await test.request("POST", "/api/v1/statuses/missing/bookmark")).status, 404);

    await bookmark(test.ctx, "bob", note.id);
    await unfollow(test.ctx, "bob", "alice");
    const undone = await test.request("POST", `${path}/unbookmark`);
    assertEquals([undone.status, undone.body.bookmarked], [200, false]);
});

Deno.test("the viewer's bookmarks are listed, the latest bookmarked first, if still seen", async () => {
    await using test = await open();
    const older = await createNote(test.ctx, "alice");
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    const newer = await createNote(test.ctx, "dave");
    for (const note of [newer, hidden, older]) await bookmark(test.ctx, "bob", note.id);
    await bookmark(test.ctx, "dave", older.id);
    await unfollow(test.ctx, "bob", "alice");

    const all = await test.request("GET", "/api/v1/bookmarks");
    assertEquals(all.body.map((status: { id: string }) => status.id), [older.id, newer.id]);
    assertEquals(all.body[0].bookmarked, true);

    // Pages go by the bookmarks, so the one bob can no longer see still takes its place.
    const first = await test.request("GET", "/api/v1/bookmarks?limit=2");
    assertEquals(first.body.map((status: { id: string }) => status.id), [older.id]);
    const next = new URL(first.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    const second = await test.request("GET", next.pathname + next.search);
    assertEquals(second.body.map((status: { id: string }) => status.id), [newer.id]);

    assertEquals((await test.request("GET", "/api/v1/bookmarks", null)).status, 401);
});
