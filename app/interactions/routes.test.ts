import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { like } from "./likes.ts";
import { interactionRoutes } from "./routes.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, interactionRoutes, { checkResponses: true });
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

Deno.test("liking a status gives it back liked, and counted", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}`;

    const liked = await test.request("POST", `${path}/favourite`);
    assertEquals(
        [liked.status, liked.body.favourited, liked.body.favourites_count],
        [200, true, 1],
    );

    const undone = await test.request("POST", `${path}/unfavourite`);
    assertEquals(
        [undone.status, undone.body.favourited, undone.body.favourites_count],
        [200, false, 0],
    );
});

Deno.test("a status the viewer can't see can't be liked, or its likes listed", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });
    await like(test.ctx, "bob", note.id);
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("POST", `${path}/favourite`, "dave")).status, 404);
    assertEquals((await test.request("POST", `${path}/unfavourite`, "dave")).status, 404);
    assertEquals((await test.request("GET", `${path}/favourited_by`, "dave")).status, 404);
    assertEquals((await test.request("GET", `${path}/favourited_by`, null)).status, 404);
    assertEquals((await test.request("POST", `${path}/favourite`, null)).status, 401);
});

Deno.test("the accounts that like a status are listed, the latest first, in pages", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    for (const by of ["bob", "dave", "alice"]) await like(test.ctx, by, note.id);
    const path = `/api/v1/statuses/${note.id}/favourited_by`;

    const all = await test.request("GET", path, null);
    assertEquals(all.body.map((account: { id: string }) => account.id), ["alice", "dave", "bob"]);

    const first = await test.request("GET", `${path}?limit=2`, null);
    assertEquals(first.body.map((account: { id: string }) => account.id), ["alice", "dave"]);
    const older = new URL(first.link?.match(/<([^>]+)>; rel="next"/)?.[1] ?? "");
    const second = await test.request("GET", older.pathname + older.search, null);
    assertEquals(second.body.map((account: { id: string }) => account.id), ["bob"]);
});

Deno.test("the viewer's liked statuses are listed, the latest liked first, if still seen", async () => {
    await using test = await open();
    const older = await createNote(test.ctx, "alice");
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    const newer = await createNote(test.ctx, "dave");
    for (const note of [newer, hidden, older]) await like(test.ctx, "bob", note.id);
    await like(test.ctx, "dave", older.id);

    const liked = await test.request("GET", "/api/v1/favourites");
    assertEquals(liked.body.map((status: { id: string }) => status.id), [
        older.id,
        hidden.id,
        newer.id,
    ]);
    assertEquals(liked.body.every((status: { favourited: boolean }) => status.favourited), true);

    await unfollow(test.ctx, "bob", "alice");
    const seen = await test.request("GET", "/api/v1/favourites");
    assertEquals(seen.body.map((status: { id: string }) => status.id), [older.id, newer.id]);
});
