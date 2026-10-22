import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { blockDomainFor } from "../graph/domain_blocks.ts";
import { follow, unfollow } from "../graph/follows.ts";
import { mute } from "../graph/mutes.ts";
import { createInstance } from "../instances/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { like } from "./likes.ts";
import { react } from "./reactions.ts";
import { share } from "./shares.ts";
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

Deno.test("sharing a status gives the share, with the status in it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}`;

    const shared = await test.request("POST", `${path}/reblog`);
    assertEquals(
        [shared.status, shared.body.reblogged, shared.body.account.id, shared.body.content],
        [200, false, "bob", ""],
    );
    assertEquals(
        [shared.body.reblog.id, shared.body.reblog.reblogged, shared.body.reblog.reblogs_count],
        [note.id, true, 1],
    );
    assertEquals(
        shared.body.uri,
        `https://${test.ctx.urls.domain}/.versia/v0.6/entities/pub.versia%3Ashare%2FShare/${shared.body.id}`,
    );

    const undone = await test.request("POST", `${path}/unreblog`);
    assertEquals(
        [undone.status, undone.body.id, undone.body.reblogged, undone.body.reblogs_count],
        [200, note.id, false, 0],
    );
});

Deno.test("a status that can't be shared, or seen, is refused", async () => {
    await using test = await open();
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    const path = `/api/v1/statuses/${hidden.id}`;

    assertEquals((await test.request("POST", `${path}/reblog`)).status, 403);
    assertEquals((await test.request("POST", `${path}/reblog`, "dave")).status, 404);
    assertEquals((await test.request("POST", `${path}/unreblog`, "dave")).status, 404);
    assertEquals((await test.request("GET", `${path}/reblogged_by`, "dave")).status, 404);
});

Deno.test("the accounts that share a status publicly are listed, the latest first", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await share(test.ctx, "bob", note.id, "public");
    await share(test.ctx, "dave", note.id, "private");
    await share(test.ctx, "alice", note.id, "unlisted");

    const listed = await test.request("GET", `/api/v1/statuses/${note.id}/reblogged_by`, null);
    assertEquals(listed.body.map((account: { id: string }) => account.id), ["alice", "bob"]);
});

Deno.test("reacting to a status gives it back with the reaction, and undoing it without", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}/reactions/${encodeURIComponent("🎉")}`;

    const reacted = await test.request("PUT", path);
    assertEquals([reacted.status, reacted.body.id, reacted.body.reactions], [201, note.id, [
        { name: "🎉", count: 1, remote: false, me: true },
    ]]);
    assertEquals((await test.request("PUT", path)).body.reactions[0].count, 1);

    const undone = await test.request("DELETE", path);
    assertEquals([undone.status, undone.body.reactions], [200, []]);
});

Deno.test("a reaction with an unknown emoji, or to a status the viewer can't see, is refused", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const hidden = await createNote(test.ctx, "alice", { visibility: "private" });
    const path = (id: string, name: string) =>
        `/api/v1/statuses/${id}/reactions/${encodeURIComponent(name)}`;

    assertEquals((await test.request("PUT", path(note.id, ":nope:"))).status, 422);
    assertEquals((await test.request("DELETE", path(note.id, "nope"))).status, 422);
    assertEquals((await test.request("PUT", path(hidden.id, "🎉"), "dave")).status, 404);
    assertEquals((await test.request("PUT", path(note.id, "🎉"), null)).status, 401);
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${hidden.id}/reactions`, null)).status,
        404,
    );
});

Deno.test("a status's reactions are listed by emoji, with who made them, the latest first", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await createLocalEmoji(test.ctx, "blob");
    for (const [by, name] of [["bob", "🎉"], ["dave", ":blob:"], ["alice", "🎉"]]) {
        await react(test.ctx, by, note.id, name);
    }
    const path = `/api/v1/statuses/${note.id}/reactions`;

    assertEquals((await test.request("GET", path)).body, [
        { name: "🎉", count: 2, remote: false, me: true, account_ids: ["alice", "bob"] },
        { name: ":blob:", count: 1, remote: false, me: false, account_ids: ["dave"] },
    ]);
    assertEquals((await test.request("GET", path, null)).body, [
        { name: "🎉", count: 2, remote: false, account_ids: ["alice", "bob"] },
        { name: ":blob:", count: 1, remote: false, account_ids: ["dave"] },
    ]);
});

Deno.test("the blocker isn't shown, or counted, the likes, shares and reactions of those it blocks", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    for (const by of ["bob", "dave"]) {
        await like(test.ctx, by, note.id);
        await share(test.ctx, by, note.id, "public");
        await react(test.ctx, by, note.id, "🎉");
    }
    await react(test.ctx, "dave", note.id, "👀");
    await block(test.ctx, "alice", "dave");
    const path = `/api/v1/statuses/${note.id}`;
    const ids = async (list: string, as: string | null) =>
        (await test.request("GET", `${path}/${list}`, as)).body.map((account: { id: string }) =>
            account.id
        );

    assertEquals(await ids("favourited_by", "alice"), ["bob"]);
    assertEquals(await ids("reblogged_by", "alice"), ["bob"]);
    assertEquals((await test.request("GET", `${path}/reactions`, "alice")).body, [
        { name: "🎉", count: 1, remote: false, me: false, account_ids: ["bob"] },
    ]);
    const status =
        (await test.request("PUT", `${path}/reactions/${encodeURIComponent("🎉")}`, "alice"))
            .body;
    assertEquals([status.favourites_count, status.reblogs_count, status.reactions], [1, 1, [
        { name: "🎉", count: 2, remote: false, me: true },
    ]]);

    // Anyone else, the blocked account too, sees them all.
    for (const as of ["bob", "dave", null]) {
        assertEquals(await ids("favourited_by", as), ["dave", "bob"]);
        assertEquals(await ids("reblogged_by", as), ["dave", "bob"]);
        assertEquals(
            (await test.request("GET", `${path}/reactions`, as)).body.map((
                group: { count: number },
            ) => group.count),
            [3, 1],
        );
    }
    const seen = (await test.request("POST", `${path}/favourite`, "dave")).body;
    assertEquals([seen.favourites_count, seen.reblogs_count], [2, 2]);
});

Deno.test("the likes, shares and reactions of those the viewer mutes are still shown, and counted", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    await like(test.ctx, "dave", note.id);
    await share(test.ctx, "dave", note.id, "public");
    await react(test.ctx, "dave", note.id, "🎉");
    await mute(test.ctx, "alice", "dave", { notifications: true, duration: 0 });
    const path = `/api/v1/statuses/${note.id}`;
    const ids = async (list: string) =>
        (await test.request("GET", `${path}/${list}`, "alice")).body.map((
            account: { id: string },
        ) => account.id);

    assertEquals(await ids("favourited_by"), ["dave"]);
    assertEquals(await ids("reblogged_by"), ["dave"]);
    assertEquals(
        (await test.request("GET", `${path}/reactions`, "alice")).body[0].account_ids,
        ["dave"],
    );
    const status = (await test.request("POST", `${path}/favourite`, "alice")).body;
    assertEquals([status.favourites_count, status.reblogs_count], [2, 1]);
});

Deno.test("the blocker isn't shown, or counted, the likes of the accounts on domains it blocks", async () => {
    await using test = await open();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "erin", "b.example");
    const note = await createNote(test.ctx, "alice");
    for (const by of ["bob", "erin"]) await like(test.ctx, by, note.id);
    await blockDomainFor(test.ctx, "alice", "b.example");
    const path = `/api/v1/statuses/${note.id}`;
    const ids = async (as: string) =>
        (await test.request("GET", `${path}/favourited_by`, as)).body.map((
            account: { id: string },
        ) => account.id);

    assertEquals(await ids("alice"), ["bob"]);
    // Her own like, and bob's.
    assertEquals(
        (await test.request("POST", `${path}/favourite`, "alice")).body.favourites_count,
        2,
    );
    assertEquals(await ids("bob"), ["alice", "erin", "bob"]);
});
