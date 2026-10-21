import { assertEquals, assertStringIncludes } from "@std/assert";
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
    const app = createTestApp(test.ctx, noteRoutes(defaultSettings().limits), {
        checkResponses: true,
    });
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

    /** Posts a status as `as`, in JSON, or as a form if `body` is a string. */
    const post = async (body: Record<string, unknown> | string, as = "alice", on: App = app) => {
        const response = await on.request("/api/v1/statuses", {
            method: "POST",
            headers: {
                authorization: `Bearer ${await tokenFor(test.ctx, as)}`,
                "content-type": typeof body === "string"
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
            },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, request, post };
};

Deno.test("a status is posted as the client asks, and can then be seen", async () => {
    await using test = await open();

    const posted = await test.post({
        status: "Hi *@bob*",
        content_type: "text/markdown",
        spoiler_text: "Greeting",
        visibility: "private",
        language: "en",
    });
    assertEquals(posted.status, 200);
    assertEquals(
        [posted.body.visibility, posted.body.sensitive, posted.body.language],
        ["private", true, "en"],
    );
    assertEquals(posted.body.mentions.map((mention: { id: string }) => mention.id), ["bob"]);
    assertStringIncludes(posted.body.content, "<em>");

    const path = `/api/v1/statuses/${posted.body.id}`;
    assertEquals((await test.request("GET", path, "bob")).status, 200);
    assertEquals((await test.request("GET", path, "dave")).status, 404);

    const form = await test.post("status=Hi&language=&in_reply_to_id=" + posted.body.id, "bob");
    assertEquals(
        [form.status, form.body.content, form.body.language, form.body.in_reply_to_id],
        [200, "<p>Hi</p>", null, posted.body.id],
    );
    assertEquals(
        (await test.post({ status: "Hi", in_reply_to_id: posted.body.id }, "dave")).status,
        404,
    );
});

Deno.test("a status and its warning are held to the limit, with links counting as 23", async () => {
    await using test = await open();
    const limited = createTestApp(
        test.ctx,
        noteRoutes({ ...defaultSettings().limits, status: 50 }),
    );
    const link = `https://example.com/${"a".repeat(100)}`;
    const rejected = async (body: Record<string, unknown>) => {
        const reply = await test.post(body, "alice", limited);
        return reply.status === 422 ? reply.body.details : reply.status;
    };

    assertEquals(await rejected({ status: "a".repeat(50) }), 200);
    assertEquals(await rejected({ status: `${"a".repeat(26)} ${link}` }), 200);
    assertEquals(await rejected({ status: "a".repeat(51) }), {
        "body.status": ["Must be at most 50 characters"],
    });
    assertEquals(await rejected({ status: "a".repeat(40), spoiler_text: "a".repeat(11) }), {
        "body.status": ["Must be at most 50 characters"],
    });
    assertEquals(await rejected({ status: " \n" }), { "body.status": ["Can't be blank"] });

    // And by default, 10,000.
    assertEquals((await test.post({ status: "a".repeat(10_000) })).status, 200);
    assertEquals((await test.post({ status: "a".repeat(10_001) })).status, 422);
});

Deno.test("attachments, polls and schedules are refused, until Verso has them", async () => {
    await using test = await open();
    const fields = async (body: Record<string, unknown> | string) =>
        Object.keys((await test.post(body)).body.details ?? {});

    assertEquals(await fields({ status: "Hi", media_ids: ["1"] }), ["body.media_ids"]);
    assertEquals(await fields("status=Hi&media_ids[]=1"), ["body.media_ids"]);
    assertEquals(await fields("status=Hi&poll[options][]=a&poll[options][]=b"), ["body.poll"]);
    assertEquals(await fields({ status: "Hi", scheduled_at: "2030-01-01T00:00:00Z" }), [
        "body.scheduled_at",
    ]);

    const empty = await test.post({ status: "Hi", media_ids: [], poll: null, scheduled_at: null });
    assertEquals(empty.status, 200);

    // As forms send a field left empty; and without a content type, the text is plain.
    const form = await test.post("status=Hi *there*&scheduled_at=");
    assertEquals([form.status, form.body.content], [200, "<p>Hi *there*</p>"]);
});

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

Deno.test("statuses are posted, read and deleted with tokens and roles that may", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const path = `/api/v1/statuses/${note.id}`;

    assertEquals((await test.request("GET", path, "alice", ["read:accounts"])).status, 403);
    assertEquals((await test.request("GET", path, "alice", ["read:statuses"])).status, 200);
    assertEquals((await test.request("DELETE", path, "alice", ["read"])).status, 403);
    assertEquals((await test.request("POST", "/api/v1/statuses", "alice", ["read"])).status, 403);

    const limited = createTestApp(test.ctx, noteRoutes(defaultSettings().limits), {
        permissions: { anonymous: [], default: ["read:account"] },
    });
    assertEquals((await test.request("GET", path, null, undefined, limited)).status, 403);
    assertEquals((await test.request("GET", path, "bob", undefined, limited)).status, 403);
    assertEquals((await test.request("DELETE", path, "alice", undefined, limited)).status, 403);
    assertEquals((await test.post({ status: "Hi" }, "alice", limited)).status, 403);
    assertEquals((await test.request("DELETE", path, "alice", ["write:statuses"])).status, 200);
});

Deno.test("statuses are served among every route", async () => {
    await using test = await open();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    const note = await createNote(test.ctx, "alice");

    const response = await app.request(`/api/v1/statuses/${note.id}`);
    assertEquals([response.status, (await response.json()).id], [200, note.id]);
});
