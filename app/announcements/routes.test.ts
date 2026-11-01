import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { removeAnnouncement } from "./announcements.ts";
import { announcementRoutes } from "./routes.ts";
import { announce } from "./testing.ts";

/** alice and bob, local users. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, announcementRoutes, { checkResponses: true });
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    const call = async (method: string, path: string, token?: string) => {
        const response = await app.request(path, {
            method,
            headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, call };
};

Deno.test("announcements are listed with what they link to, and whether they were dismissed", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "verso");
    await createLocalEmoji(test.ctx, "other");
    const note = await createNote(test.ctx, "bob");
    const url = (id: string) => `https://social.example/.versia/v0.6/entities/Note/${id}`;

    const made = await announce(test.ctx, `Hi @bob :verso: #News ${url(note.id)}`, {
        startsAt: new Date("2026-02-01T00:00:00Z"),
        endsAt: new Date("2026-02-02T00:00:00Z"),
        allDay: true,
    });
    const later = await announce(test.ctx, "Later", { scheduledAt: new Date("2027-01-01") });
    const token = await tokenFor(test.ctx, "alice", ["read"]);

    const listed = await test.call("GET", "/api/v1/announcements", token);
    assertEquals(listed.status, 200);
    assertEquals(listed.body.length, 1);
    const [shown] = listed.body;
    assertEquals({ ...shown, statuses: shown.statuses.map((s: { id: string }) => s.id) }, {
        id: made.id,
        content: made.content_html,
        starts_at: "2026-02-01T00:00:00.000Z",
        ends_at: "2026-02-02T00:00:00.000Z",
        all_day: true,
        published_at: test.clock.now().toISOString(),
        updated_at: test.clock.now().toISOString(),
        read: false,
        mentions: [{
            id: "bob",
            username: "bob",
            url: "https://social.example/.versia/v0.6/entities/User/bob",
            acct: "bob",
        }],
        statuses: [note.id],
        tags: [{ name: "News", url: "https://social.example/tags/news" }],
        emojis: [shown.emojis[0]],
        reactions: [],
    });
    assertEquals(shown.emojis.map((e: { shortcode: string }) => e.shortcode), ["verso"]);

    // Dismissing one marks it read, for whoever dismissed it, and again does no harm.
    const write = await tokenFor(test.ctx, "alice", ["write:accounts"]);
    const dismiss = `/api/v1/announcements/${made.id}/dismiss`;
    assertEquals(await test.call("POST", dismiss, write), { status: 200, body: {} });
    assertEquals(await test.call("POST", dismiss, write), { status: 200, body: {} });
    assertEquals((await test.call("GET", "/api/v1/announcements", token)).body[0].read, true);
    const bobs = await test.call("GET", "/api/v1/announcements", await tokenFor(test.ctx, "bob"));
    assertEquals(bobs.body[0].read, false);

    const unpublished = await test.call("POST", `/api/v1/announcements/${later.id}/dismiss`, write);
    assertEquals(unpublished.status, 404);
    await removeAnnouncement(test.ctx, made.id);
    assertEquals((await test.call("POST", dismiss, write)).status, 404);
});

Deno.test("announcements are for users, and dismissing them needs write:accounts", async () => {
    await using test = await open();
    const made = await announce(test.ctx, "Hi");
    const dismiss = `/api/v1/announcements/${made.id}/dismiss`;

    assertEquals((await test.call("GET", "/api/v1/announcements")).status, 401);
    assertEquals(
        (await test.call("GET", "/api/v1/announcements", await tokenFor(test.ctx, null))).status,
        422,
    );
    assertEquals(
        (await test.call(
            "GET",
            "/api/v1/announcements",
            await tokenFor(test.ctx, "alice", [
                "push",
            ]),
        )).status,
        200,
    );
    assertEquals(
        (await test.call("POST", dismiss, await tokenFor(test.ctx, "alice", ["read"]))).status,
        403,
    );
});
