import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import type { App } from "../http/app.ts";
import { routes } from "../http/routes.ts";
import { defaultSettings } from "../instances/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { findNote } from "./note_queries.ts";
import { noteRoutes } from "./routes.ts";
import { createNote } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, noteRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    /** Sends a request as `as`, or as nobody if it is `null`. */
    const request = async (
        method: string,
        path: string,
        as: string | null = "alice",
        scopes?: Scope[],
        on: App = app,
    ) => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as, scopes)}` };
        const response = await on.request(path, { method, headers });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, request };
};

Deno.test("a status is given to whoever may see it, and is missing to anyone else", async () => {
    await using test = await open();
    const everyone = await createNote(test.ctx, "alice", { visibility: "public" });
    const followers = await createNote(test.ctx, "alice", { visibility: "private" });
    const direct = await createNote(test.ctx, "alice", { visibility: "direct" }, ["dave"]);
    const status = (id: string, as: string | null) =>
        test.request("GET", `/api/v1/statuses/${id}`, as).then((reply) => reply.status);

    assertEquals(await status(everyone.id, null), 200);
    assertEquals(
        (await test.request("GET", `/api/v1/statuses/${everyone.id}`, null)).body.id,
        everyone.id,
    );
    assertEquals([await status(followers.id, null), await status(followers.id, "bob")], [404, 200]);
    assertEquals(await status(followers.id, "dave"), 404);
    assertEquals([await status(direct.id, "bob"), await status(direct.id, "dave")], [404, 200]);
    assertEquals(await status("missing", "alice"), 404);
});

Deno.test("deleting a status gives it back as written, and only its author may", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { content: "Hi *there*" });
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("DELETE", path, "bob")).status, 404);
    assertEquals((await test.request("DELETE", "/api/v1/statuses/missing")).status, 404);

    const deleted = await test.request("DELETE", path);
    assertEquals([deleted.status, deleted.body.id, deleted.body.text], [
        200,
        note.id,
        "Hi *there*",
    ]);
    assertEquals(await findNote(test.ctx, note.id), undefined);
    assertEquals((await test.request("DELETE", path)).status, 404);
    assertEquals((await test.request("GET", path)).status, 404);
});

Deno.test("statuses are read and deleted with tokens and roles that may", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("GET", path, "alice", ["read:accounts"])).status, 403);
    assertEquals((await test.request("GET", path, "alice", ["read:statuses"])).status, 200);
    assertEquals((await test.request("DELETE", path, "alice", ["read"])).status, 403);

    const limited = createTestApp(test.ctx, noteRoutes, {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    assertEquals((await test.request("GET", path, null, undefined, limited)).status, 403);
    assertEquals((await test.request("GET", path, "bob", undefined, limited)).status, 403);
    assertEquals((await test.request("DELETE", path, "alice", undefined, limited)).status, 403);
    assertEquals((await test.request("DELETE", path, "alice", ["write:statuses"])).status, 200);
});

Deno.test("statuses are served among every route", async () => {
    await using test = await open();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    const note = await createNote(test.ctx, "alice");

    const response = await app.request(`/api/v1/statuses/${note.id}`);
    assertEquals([response.status, (await response.json()).id], [200, note.id]);
});
