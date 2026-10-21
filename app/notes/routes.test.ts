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
    const post = async (
        body: Record<string, unknown> | string,
        as = "alice",
        on: App = app,
        method = "POST",
        path = "/api/v1/statuses",
    ) => {
        const response = await on.request(path, {
            method,
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

    /** Edits a status as `as`, as {@link post} posts one. */
    const edit = (id: string, body: Record<string, unknown> | string, as = "alice", on = app) =>
        post(body, as, on, "PUT", `/api/v1/statuses/${id}`);

    return { ...test, app, request, post, edit };
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

Deno.test("a status is edited by its author, and keeps what the edit leaves out", async () => {
    await using test = await open();
    const posted = await test.post({
        status: "Hi",
        content_type: "text/markdown",
        spoiler_text: "Greeting",
        visibility: "private",
        language: "en",
    });
    const id = posted.body.id;

    const edited = await test.edit(id, { status: "Hi *@bob*", language: "" });
    assertEquals(edited.status, 200);
    assertEquals(
        [
            edited.body.id,
            edited.body.spoiler_text,
            edited.body.visibility,
            edited.body.language,
            edited.body.edited_at,
        ],
        [id, "Greeting", "private", "en", test.clock.now().toISOString()],
    );
    assertStringIncludes(edited.body.content, "<em>");
    assertEquals(edited.body.mentions.map((mention: { id: string }) => mention.id), ["bob"]);

    const form = await test.edit(
        id,
        "status=Bye *now*&spoiler_text=&sensitive=true&content_type=text/plain",
    );
    assertEquals([form.status, form.body.content, form.body.spoiler_text, form.body.sensitive], [
        200,
        "<p>Bye *now*</p>",
        "",
        true,
    ]);

    assertEquals((await test.edit(id, { status: "Hi" }, "bob")).status, 404);
    assertEquals((await test.edit("missing", { status: "Hi" })).status, 404);
    assertEquals((await test.edit(id, { status: "" })).body.details, {
        "body.status": ["Can't be blank"],
    });
    assertEquals(Object.keys((await test.edit(id, { status: "Hi", poll: {} })).body.details), [
        "body.poll",
    ]);
});

Deno.test("an edited status is held to the limit, with the warning it gives", async () => {
    await using test = await open();
    const limited = createTestApp(
        test.ctx,
        noteRoutes({ ...defaultSettings().limits, status: 50 }),
    );
    const note = await createNote(test.ctx, "alice");
    const status = async (body: Record<string, unknown>) =>
        (await test.edit(note.id, body, "alice", limited)).status;

    assertEquals(await status({ status: "a".repeat(50) }), 200);
    assertEquals(await status({ status: "a".repeat(51) }), 422);
    assertEquals(await status({ status: "a".repeat(40), spoiler_text: "a".repeat(11) }), 422);
});

Deno.test("a status's thread is given to whoever may see it, without what they may not", async () => {
    await using test = await open();
    const root = await createNote(test.ctx, "alice");
    const note = await createNote(test.ctx, "bob", {
        in_reply_to_id: root.id,
        in_reply_to_account_id: "alice",
    });
    const secret = await createNote(test.ctx, "alice", {
        visibility: "private",
        in_reply_to_id: note.id,
        in_reply_to_account_id: "bob",
    });
    const context = async (id: string, as: string | null) => {
        const reply = await test.request("GET", `/api/v1/statuses/${id}/context`, as);
        return reply.status === 200
            ? [
                reply.body.ancestors.map((status: { id: string }) => status.id),
                reply.body.descendants.map((status: { id: string }) => status.id),
            ]
            : reply.status;
    };

    assertEquals(await context(note.id, "bob"), [[root.id], [secret.id]]);
    assertEquals(await context(note.id, null), [[root.id], []]);
    assertEquals(await context(secret.id, "dave"), 404);
    assertEquals(await context("missing", "alice"), 404);
});

Deno.test("an account's statuses are those the viewer may see, newest first", async () => {
    await using test = await open();
    const ids = [];
    for (const visibility of ["public", "unlisted", "private", "direct"] as const) {
        test.clock.advance(1);
        ids.push((await createNote(test.ctx, "alice", { visibility })).id);
    }
    const statuses = async (as: string | null, query = "") => {
        const reply = await test.request("GET", `/api/v1/accounts/alice/statuses${query}`, as);
        return reply.status === 200
            ? reply.body.map((status: { id: string }) => status.id)
            : reply.status;
    };

    assertEquals(await statuses(null), [ids[1], ids[0]]);
    assertEquals(await statuses("dave"), [ids[1], ids[0]]);
    assertEquals(await statuses("bob"), [ids[2], ids[1], ids[0]]);
    assertEquals(await statuses("alice"), ids.toReversed());
    assertEquals(await statuses("alice", `?max_id=${ids[2]}&limit=1`), [ids[1]]);
    assertEquals(await statuses("alice", "?only_media=true"), []);
    assertEquals(await statuses("alice", "?pinned=1"), []);
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/nobody/statuses")).status,
        404,
    );

    const response = await test.app.request("/api/v1/accounts/alice/statuses?limit=2");
    assertStringIncludes(response.headers.get("link") ?? "", `max_id=${ids[0]}>; rel="next"`);
});

Deno.test("an account's statuses may leave out replies to others, or be only those with a hashtag", async () => {
    await using test = await open();
    const other = await createNote(test.ctx, "bob");
    const own = await createNote(test.ctx, "alice", {}, [], ["verso"]);
    const toSelf = await createNote(test.ctx, "alice", {
        in_reply_to_id: own.id,
        in_reply_to_account_id: "alice",
    });
    const toBob = await createNote(
        test.ctx,
        "alice",
        {
            in_reply_to_id: other.id,
            in_reply_to_account_id: "bob",
        },
        [],
        ["verso", "deno"],
    );
    const statuses = async (query: string) =>
        (await test.request("GET", `/api/v1/accounts/alice/statuses${query}`)).body
            .map((status: { id: string }) => status.id);

    assertEquals(await statuses(""), [toBob.id, toSelf.id, own.id]);
    assertEquals(await statuses("?exclude_replies=true"), [toSelf.id, own.id]);
    assertEquals(await statuses("?tagged=Verso"), [toBob.id, own.id]);
    assertEquals(await statuses("?tagged=deno&exclude_replies=1"), []);
    assertEquals(await statuses("?exclude_reblogs=true"), [toBob.id, toSelf.id, own.id]);
});

Deno.test("a status's history is given to whoever may see it", async () => {
    await using test = await open();
    const everyone = await createNote(test.ctx, "alice");
    const followers = await createNote(test.ctx, "alice", { visibility: "private" });
    await test.edit(everyone.id, { status: "Bye" });
    const history = (id: string, as: string | null) =>
        test.request("GET", `/api/v1/statuses/${id}/history`, as);

    const edited = await history(everyone.id, null);
    assertEquals(edited.status, 200);
    assertEquals(edited.body.map((version: { content: string }) => version.content), [
        "<p>Hi</p>",
        "<p>Bye</p>",
    ]);
    assertEquals([(await history(followers.id, "bob")).body.length], [1]);
    assertEquals((await history(followers.id, "dave")).status, 404);
    assertEquals((await history("missing", "alice")).status, 404);
});

Deno.test("a status's source is what its author wrote, for whoever may see it", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", {
        visibility: "private",
        content: "Hi *there*",
        content_format: "text/markdown",
        spoiler_text: "Greeting",
    });
    const path = `/api/v1/statuses/${note.id}/source`;

    assertEquals(await test.request("GET", path, "bob"), {
        status: 200,
        body: {
            id: note.id,
            text: "Hi *there*",
            spoiler_text: "Greeting",
            content_type: "text/markdown",
        },
    });
    assertEquals((await test.request("GET", path, "dave")).status, 404);
    assertEquals((await test.request("GET", path, null)).status, 401);
    assertEquals((await test.request("GET", "/api/v1/statuses/missing/source")).status, 404);
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
    assertEquals((await test.edit(note.id, { status: "Hi" }, "alice", limited)).status, 403);
    assertEquals(
        (await test.request("GET", `${path}/source`, "bob", undefined, limited)).status,
        403,
    );
    assertEquals((await test.request("PUT", path, "alice", ["read"])).status, 403);
    assertEquals((await test.request("GET", `${path}/source`, "alice", ["write"])).status, 403);
    assertEquals((await test.request("GET", `${path}/history`, "alice", ["write"])).status, 403);
    assertEquals(
        (await test.request("GET", `${path}/history`, null, undefined, limited)).status,
        403,
    );
    assertEquals(
        (await test.request("GET", `${path}/context`, null, undefined, limited)).status,
        403,
    );
    assertEquals((await test.request("GET", `${path}/context`, "alice", ["write"])).status, 403);
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/alice/statuses", null, undefined, limited))
            .status,
        403,
    );
    assertEquals(
        (await test.request("GET", "/api/v1/accounts/alice/statuses", "alice", ["write"])).status,
        403,
    );

    // Reading notes isn't enough to change them.
    const readers = createTestApp(test.ctx, noteRoutes(defaultSettings().limits), {
        permissions: { anonymous: [], default: ["read:note"] },
    });
    assertEquals((await test.edit(note.id, { status: "Hi" }, "alice", readers)).status, 403);
    assertEquals(
        (await test.request("GET", `${path}/source`, "bob", undefined, readers)).status,
        200,
    );
    assertEquals((await test.request("DELETE", path, "alice", ["write:statuses"])).status, 200);
});

Deno.test("statuses are served among every route", async () => {
    await using test = await open();
    const app = createTestApp(test.ctx, routes(defaultSettings()));
    const note = await createNote(test.ctx, "alice");

    const response = await app.request(`/api/v1/statuses/${note.id}`);
    assertEquals([response.status, (await response.json()).id], [200, note.id]);
});
