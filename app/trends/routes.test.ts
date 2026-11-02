import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { createNote } from "../notes/testing.ts";
import { followTag } from "../tags/tag_follows.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { refreshTrends } from "./refresh.ts";
import { trendRoutes } from "./routes.ts";

const hour = 60 * 60 * 1000;
const authors = ["alice", "b", "c", "d", "e"];

/** Five discoverable local users, who used #cats and #dogs, and have a popular status each. */
const open = async (instance = { show_trends: true, trendable_by_default: true }) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, trendRoutes(instance), { checkResponses: true });
    test.clock.advance(12 * hour);
    for (const id of authors) await createLocalAccount(test.ctx, id);
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();

    const notes: Record<string, string> = {};
    for (const [index, id] of authors.entries()) {
        const tags = index < 4 ? ["cats", "dogs"] : ["cats"];
        const note = await createNote(test.ctx, id, { likes_count: 5 + index }, [], tags);
        notes[id] = note.id;
    }
    await refreshTrends(test.ctx);

    const call = async (path: string, token?: string) => {
        const response = await app.request(path, {
            headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });

        return { status: response.status, body: await response.json(), headers: response.headers };
    };

    return { ...test, call, notes };
};

Deno.test("trending hashtags are listed, the highest scoring first, with their history", async () => {
    await using test = await open();

    const { status, body } = await test.call("/api/v1/trends/tags");
    assertEquals(status, 200);
    assertEquals(body.map((tag: { name: string }) => tag.name), ["cats"]);
    assertEquals(body[0].url, "https://social.example/tags/cats");
    assertEquals(body[0].history[0], { day: "1767225600", accounts: "5", uses: "5" });
    assertEquals((await test.call("/api/v1/trends")).body, body);
});

Deno.test("trending hashtags show whether the viewer follows them", async () => {
    await using test = await open();
    await followTag(test.ctx, "alice", "cats");

    const token = await tokenFor(test.ctx, "alice", ["read"]);
    assertEquals((await test.call("/api/v1/trends/tags", token)).body[0].following, true);
    assertEquals("following" in (await test.call("/api/v1/trends/tags")).body[0], false);
});

Deno.test("trending hashtags are paged by offset, as Mastodon pages them", async () => {
    await using test = await open();
    const [tag] = authors.slice(0, 4).map((id) => id);
    await createNote(test.ctx, tag, {}, [], ["owls"]);
    for (const id of authors.slice(1, 5)) await createNote(test.ctx, id, {}, [], ["owls"]);
    test.clock.advance(1);
    await refreshTrends(test.ctx);

    const names = async (path: string) =>
        (await test.call(path)).body.map((tag: { name: string }) => tag.name);
    // The newer peak is the higher, as the first has begun to decay.
    assertEquals(await names("/api/v1/trends/tags?limit=1"), ["owls"]);
    assertEquals(await names("/api/v1/trends/tags?limit=1&offset=1"), ["cats"]);
    assertEquals(await names("/api/v1/trends/tags?limit=1&offset=2"), []);

    const first = await test.call("/api/v1/trends/tags?limit=1");
    assertEquals(
        first.headers.get("link"),
        '<https://social.example/api/v1/trends/tags?limit=1&offset=1>; rel="next"',
    );
    const second = await test.call("/api/v1/trends/tags?limit=1&offset=1");
    assertEquals(second.headers.get("link")?.includes('rel="prev"'), false);
    const third = await test.call("/api/v1/trends/tags?limit=1&offset=2");
    assertEquals(
        third.headers.get("link"),
        '<https://social.example/api/v1/trends/tags?limit=1&offset=1>; rel="prev"',
    );

    // A limit past the most there may be is lowered, and one of zero raised.
    assertEquals((await test.call("/api/v1/trends/tags?limit=0")).body.length, 1);
    assertEquals((await test.call("/api/v1/trends/tags?limit=500")).status, 200);
});

Deno.test("trending hashtags and statuses are shown only once approved, unless the default approves", async () => {
    await using test = await open({ show_trends: true, trendable_by_default: false });
    const list = async () => (await test.call("/api/v1/trends/tags")).body;

    assertEquals(await list(), []);
    assertEquals((await test.call("/api/v1/trends/statuses")).body, []);

    await test.ctx.db.updateTable("tags").set({ trendable: true }).where("name", "=", "cats")
        .execute();
    assertEquals((await list()).length, 1);
    await test.ctx.db.updateTable("tags").set({ trendable: false }).where("name", "=", "cats")
        .execute();
    assertEquals(await list(), []);

    await test.ctx.db.updateTable("accounts").set({ trendable: true }).where("id", "=", "b")
        .execute();
    const statuses = await test.call("/api/v1/trends/statuses");
    assertEquals(statuses.body.map((status: { id: string }) => status.id), [test.notes.b]);
});

Deno.test("an account an admin rejected doesn't trend, even when the default approves", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("accounts").set({ trendable: false }).where("id", "=", "e")
        .execute();

    const ids = (await test.call("/api/v1/trends/statuses")).body
        .map((status: { id: string }) => status.id);
    assertEquals(ids, [test.notes.d, test.notes.c, test.notes.b, test.notes.alice]);
});

Deno.test("trending statuses are listed with the best first, paged by offset", async () => {
    await using test = await open();

    const { status, body, headers } = await test.call("/api/v1/trends/statuses?limit=2");
    assertEquals(status, 200);
    assertEquals(body.map((s: { id: string }) => s.id), [test.notes.e, test.notes.d]);
    assertEquals(
        headers.get("link"),
        '<https://social.example/api/v1/trends/statuses?limit=2&offset=2>; rel="next"',
    );

    const later = await test.call("/api/v1/trends/statuses?limit=2&offset=4");
    assertEquals(later.body.map((s: { id: string }) => s.id), [test.notes.alice]);
    assertEquals(
        later.headers.get("link"),
        '<https://social.example/api/v1/trends/statuses?limit=2&offset=2>; rel="prev"',
    );
});

Deno.test("trending statuses leave out the authors the viewer blocked", async () => {
    await using test = await open();
    await block(test.ctx, "alice", "e");

    const token = await tokenFor(test.ctx, "alice", ["read"]);
    const ids = (await test.call("/api/v1/trends/statuses", token)).body
        .map((status: { id: string }) => status.id);
    assertEquals(ids, [test.notes.d, test.notes.c, test.notes.b, test.notes.alice]);
    assertEquals((await test.call("/api/v1/trends/statuses")).body.length, 5);
});

Deno.test("trending statuses leave out the authors who blocked the viewer", async () => {
    await using test = await open();
    await block(test.ctx, "e", "alice");

    const token = await tokenFor(test.ctx, "alice", ["read"]);
    const ids = (await test.call("/api/v1/trends/statuses", token)).body
        .map((status: { id: string }) => status.id);
    assertEquals(ids, [test.notes.d, test.notes.c, test.notes.b, test.notes.alice]);
});

Deno.test("nothing trends when the instance doesn't show trends", async () => {
    await using test = await open({ show_trends: false, trendable_by_default: true });

    for (const path of ["tags", "statuses"]) {
        assertEquals(await test.call(`/api/v1/trends/${path}`), {
            status: 200,
            body: [],
            headers: (await test.call(`/api/v1/trends/${path}`)).headers,
        });
    }
    assertEquals((await test.call("/api/v1/trends")).body, []);
});

Deno.test("trends need no sign-in, but a token must be able to read", async () => {
    await using test = await open();

    assertEquals((await test.call("/api/v1/trends/tags")).status, 200);
    assertEquals(
        (await test.call("/api/v1/trends/tags", await tokenFor(test.ctx, "alice", ["push"])))
            .status,
        200,
    );
    assertEquals(
        (await test.call("/api/v1/trends/statuses", await tokenFor(test.ctx, "alice", ["read"])))
            .status,
        200,
    );
});
