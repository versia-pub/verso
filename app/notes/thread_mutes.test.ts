import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { follow } from "../graph/follows.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { renderStatuses } from "./render.ts";
import { createNote, createShare } from "./testing.ts";
import { threadMuteRoutes } from "./thread_mute_routes.ts";

/** alice, bob, who follows her, and dave. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, threadMuteRoutes, { checkResponses: true });
    for (const id of ["alice", "bob", "dave"]) await createLocalAccount(test.ctx, id);
    await follow(test.ctx, "bob", "alice");

    /** Sends a request as `as`, or as nobody if it is `null`. */
    const request = async (path: string, as: string | null = "bob") => {
        const headers: HeadersInit = as === null
            ? {}
            : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` };
        const response = await app.request(path, { method: "POST", headers });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, request };
};

Deno.test("a reply is in the thread of the status it replies to", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const reply = await createNote(test.ctx, "bob", { in_reply_to_id: note.id });
    const deeper = await createNote(test.ctx, "alice", { in_reply_to_id: reply.id });

    assertEquals([note.thread_id, reply.thread_id, deeper.thread_id], [note.id, note.id, note.id]);
});

Deno.test("muting a status's thread mutes every status in it, for the viewer alone", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const reply = await createNote(test.ctx, "dave", { in_reply_to_id: note.id });
    const other = await createNote(test.ctx, "alice");

    const muted = await test.request(`/api/v1/statuses/${reply.id}/mute`);
    assertEquals([muted.status, muted.body.muted], [200, true]);
    assertEquals((await test.request(`/api/v1/statuses/${reply.id}/mute`)).body.muted, true);

    const seen = (viewerId: string) =>
        renderStatuses(test.ctx, [note, reply, other], viewerId).then((statuses) =>
            statuses.map((status) => status.muted)
        );
    assertEquals(await seen("bob"), [true, true, false]);
    assertEquals(await seen("dave"), [false, false, false]);

    const unmuted = await test.request(`/api/v1/statuses/${note.id}/unmute`);
    assertEquals([unmuted.status, unmuted.body.muted], [200, false]);
    assertEquals(await seen("bob"), [false, false, false]);
});

Deno.test("muting a boost mutes the thread of the status it boosts", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice");
    const boost = await createShare(test.ctx, "dave", note.id);

    const muted = await test.request(`/api/v1/statuses/${boost.id}/mute`);
    assertEquals([muted.body.id, muted.body.muted], [note.id, true]);
});

Deno.test("a thread can't be muted through a status the viewer can't see", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "alice", { visibility: "private" });

    assertEquals((await test.request(`/api/v1/statuses/${note.id}/mute`, "dave")).status, 404);
    assertEquals((await test.request(`/api/v1/statuses/${note.id}/unmute`, "dave")).status, 404);
    assertEquals((await test.request(`/api/v1/statuses/${note.id}/mute`, null)).status, 401);
    assertEquals((await test.request("/api/v1/statuses/missing/mute")).status, 404);
});
