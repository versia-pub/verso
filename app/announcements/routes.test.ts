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
            url: "https://social.example/@bob",
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

Deno.test("announcements are reacted to, and the reactions are listed with the viewer's own", async () => {
    await using test = await open();
    await createLocalEmoji(test.ctx, "verso");
    await test.ctx.db.updateTable("media").set({ preview_sha256: "emoji-verso-still" })
        .where("sha256", "=", "emoji-verso").execute();
    const made = await announce(test.ctx, "Hi");
    const later = await announce(test.ctx, "Later", { scheduledAt: new Date("2027-01-01") });
    const alice = await tokenFor(test.ctx, "alice", ["read", "write:favourites"]);
    const bob = await tokenFor(test.ctx, "bob", ["read", "write:favourites"]);
    const react = (id: string, name: string) =>
        `/api/v1/announcements/${id}/reactions/${encodeURIComponent(name)}`;

    assertEquals(await test.call("PUT", react(made.id, "👍"), alice), { status: 200, body: {} });
    assertEquals(await test.call("PUT", react(made.id, "verso"), alice), { status: 200, body: {} });
    assertEquals(await test.call("PUT", react(made.id, "verso"), bob), { status: 200, body: {} });

    const reactions = async (token: string) =>
        (await test.call("GET", "/api/v1/announcements", token)).body[0].reactions;
    assertEquals(await reactions(alice), [
        { name: "👍", count: 1, me: true },
        {
            name: "verso",
            count: 2,
            me: true,
            url: "https://social.example/media/emoji-verso",
            static_url: "https://social.example/media/emoji-verso-still",
        },
    ]);
    assertEquals((await reactions(bob)).map((reaction: { me: boolean }) => reaction.me), [
        false,
        true,
    ]);

    assertEquals(await test.call("DELETE", react(made.id, "verso"), alice), {
        status: 200,
        body: {},
    });
    assertEquals((await reactions(alice)).map((reaction: { count: number }) => reaction.count), [
        1,
        1,
    ]);

    // As on Mastodon, undoing what wasn't done is not found, and the rest is unprocessable.
    assertEquals((await test.call("DELETE", react(made.id, "verso"), alice)).status, 404);
    assertEquals((await test.call("PUT", react(later.id, "👍"), alice)).status, 404);
    assertEquals((await test.call("DELETE", react(later.id, "👍"), alice)).status, 404);
    assertEquals(await test.call("PUT", react(made.id, "👍"), alice), {
        status: 422,
        body: { error: "Validation failed", error_description: "Duplicate record" },
    });
    assertEquals((await test.call("PUT", react(made.id, "nobody"), alice)).body, {
        error: "Validation failed",
        error_description: "Name is not a recognized emoji",
    });
});

Deno.test("an announcement can't be reacted to with more than a few different emojis", async () => {
    await using test = await open();
    const made = await announce(test.ctx, "Hi");
    const alice = await tokenFor(test.ctx, "alice", ["write:favourites"]);
    const react = (name: string) =>
        test.call(
            "PUT",
            `/api/v1/announcements/${made.id}/reactions/${encodeURIComponent(name)}`,
            alice,
        );

    for (const name of ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆"]) {
        assertEquals((await react(name)).status, 200);
    }
    assertEquals(await react("😉"), {
        status: 422,
        body: {
            error: "Validation failed",
            error_description: "Limit of different reactions reached",
        },
    });
});

Deno.test("reacting to announcements needs write:favourites", async () => {
    await using test = await open();
    const made = await announce(test.ctx, "Hi");
    const react = `/api/v1/announcements/${made.id}/reactions/${encodeURIComponent("👍")}`;

    for (const method of ["PUT", "DELETE"]) {
        assertEquals((await test.call(method, react)).status, 401);
        assertEquals((await test.call(method, react, await tokenFor(test.ctx, null))).status, 422);
        const read = await tokenFor(test.ctx, "alice", ["read", "write:accounts"]);
        assertEquals((await test.call(method, react, read)).status, 403);
    }
});
