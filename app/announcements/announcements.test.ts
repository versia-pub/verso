import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { findAnnouncement, publishedAnnouncements } from "./announcement_queries.ts";
import {
    announcementChanged,
    type AnnouncementChangedMessage,
    changeAnnouncement,
    createAnnouncement,
    dismissAnnouncement,
    publishAnnouncement,
    publishDueAnnouncements,
    removeAnnouncement,
    unpublishAnnouncement,
} from "./announcements.ts";
import { reactToAnnouncement } from "./reactions.ts";
import { renderAnnouncements } from "./render.ts";
import { announce } from "./testing.ts";

const minute = 60_000;

/** A test context, with what is published on {@link announcementChanged}. */
const open = async () => {
    const test = await createTestContext();
    const heard: AnnouncementChangedMessage[] = [];
    subscribe(test.ctx, announcementChanged, (message) => {
        heard.push(message);
        return Promise.resolve();
    });

    const later = (ms: number) => new Date(test.clock.now().getTime() + ms);
    const published = async () => (await publishedAnnouncements(test.ctx)).map((row) => row.id);

    return { ...test, heard, later, published };
};

Deno.test("an announcement is published at once, unless it is scheduled for later", async () => {
    await using test = await open();
    const now = await announce(test.ctx, "Now");
    const past = await announce(test.ctx, "Past", { scheduledAt: test.later(0) });
    const scheduled = await announce(test.ctx, "Later", { scheduledAt: test.later(5 * minute) });

    assertEquals(now.published_at, test.clock.now());
    assertEquals([past.scheduled_at, scheduled.published_at], [null, null]);
    assertEquals(await test.published(), [now.id, past.id]);

    test.clock.advance(4 * minute);
    await publishDueAnnouncements(test.ctx);
    assertEquals(await test.published(), [now.id, past.id]);

    test.clock.advance(minute);
    await publishDueAnnouncements(test.ctx);
    assertEquals(await test.published(), [now.id, past.id, scheduled.id]);
    assertEquals(await findAnnouncement(test.ctx, scheduled.id), {
        ...scheduled,
        scheduled_at: null,
        published_at: test.clock.now(),
        updated_at: test.clock.now(),
    });
    assertEquals(test.heard, [
        { id: now.id, published: true },
        { id: past.id, published: true },
        { id: scheduled.id, published: true },
    ]);
});

Deno.test("an announcement is taken down when its event ends, and apps are told", async () => {
    await using test = await open();
    const ending = await announce(test.ctx, "Ending", {
        startsAt: test.later(0),
        endsAt: test.later(2 * minute),
    });
    const lasting = await announce(test.ctx, "Lasting");

    test.clock.advance(minute);
    await publishDueAnnouncements(test.ctx);
    assertEquals(await test.published(), [ending.id, lasting.id]);

    test.clock.advance(minute);
    await publishDueAnnouncements(test.ctx);
    assertEquals(await test.published(), [lasting.id]);
    assertEquals((await findAnnouncement(test.ctx, ending.id))?.published_at, null);
    assertEquals(test.heard.at(-1), { id: ending.id, published: false });
});

Deno.test("published announcements are in the order their events start, then published", async () => {
    await using test = await open();
    const first = await announce(test.ctx, "First");
    test.clock.advance(minute);
    const event = await announce(test.ctx, "Event", {
        startsAt: test.later(-2 * minute),
        endsAt: test.later(minute),
    });
    test.clock.advance(minute);
    const second = await announce(test.ctx, "Second");

    assertEquals(await test.published(), [event.id, first.id, second.id]);
});

Deno.test("an announcement must say something, and have both an event's start and end", async () => {
    await using test = await open();
    const input = { startsAt: null, endsAt: null, allDay: false, scheduledAt: null };

    assertEquals(await createAnnouncement(test.ctx, { ...input, text: " \n" }), {
        invalid: "The text can't be empty",
    });
    const halfEvent = { invalid: "An event needs both when it starts and when it ends" };
    assertEquals(
        await createAnnouncement(test.ctx, { ...input, text: "Hi", startsAt: test.later(0) }),
        halfEvent,
    );
    assertEquals(
        await createAnnouncement(test.ctx, { ...input, text: "Hi", endsAt: test.later(0) }),
        halfEvent,
    );

    const made = await announce(test.ctx, "Hi");
    assertEquals(await changeAnnouncement(test.ctx, made.id, { endsAt: test.later(0) }), halfEvent);
    assertEquals(await changeAnnouncement(test.ctx, made.id, { text: "" }), {
        invalid: "The text can't be empty",
    });
    assertEquals(await publishedAnnouncements(test.ctx), [made]);
    assertEquals(test.heard.length, 1);
});

Deno.test("an announcement links what it mentions, its hashtags and its statuses", async () => {
    await using test = await open();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const shown = await createNote(test.ctx, "bob");
    const unlisted = await createNote(test.ctx, "bob", { visibility: "unlisted" });
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });
    const url = (id: string) => `https://social.example/.versia/v0.6/entities/Note/${id}`;

    const made = await announce(
        test.ctx,
        `Hi @bob, @Bob and @nobody! #Verso\n${url(hidden.id)} ${url(unlisted.id)} ${
            url(shown.id)
        } ${url(shown.id)} https://elsewhere.example/`,
    );

    assertEquals([made.account_ids, made.note_ids], [["bob"], [unlisted.id, shown.id]]);
    assertStringIncludes(made.content_html, 'class="u-url mention">@<span>bob</span></a>');
    assertStringIncludes(made.content_html, "@nobody!");
    assertStringIncludes(
        made.content_html,
        '<a href="https://social.example/tags/verso" class="mention hashtag" rel="tag">',
    );
    assertStringIncludes(made.content_html, '<a href="https://elsewhere.example/"');
});

Deno.test("changing an announcement keeps what isn't changed, and streams it if published", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    const made = await announce(test.ctx, "Hi @bob", {
        startsAt: test.later(0),
        endsAt: test.later(60 * minute),
    });
    test.clock.advance(minute);

    // One published already can't be scheduled.
    const changed = await changeAnnouncement(test.ctx, made.id, {
        allDay: true,
        scheduledAt: test.later(minute),
    });
    assertEquals(changed, { ...made, all_day: true, updated_at: test.clock.now() });

    const retold = await changeAnnouncement(test.ctx, made.id, {
        text: "Bye",
        startsAt: null,
        endsAt: null,
    });
    assertEquals(retold, {
        ...made,
        text: "Bye",
        content_html: "<p>Bye</p>",
        account_ids: [],
        starts_at: null,
        ends_at: null,
        all_day: true,
        updated_at: test.clock.now(),
    });
    assertEquals(test.heard.length, 3);

    await unpublishAnnouncement(test.ctx, made.id);
    await changeAnnouncement(test.ctx, made.id, { text: "Draft" });
    assertEquals(test.heard.length, 4);
    assertEquals(await changeAnnouncement(test.ctx, "x", { text: "Hi" }), "missing");
});

Deno.test("an announcement is published and taken down by admins, each once", async () => {
    await using test = await open();
    const made = await announce(test.ctx, "Hi");
    const scheduled = await announce(test.ctx, "Later", { scheduledAt: test.later(minute) });
    test.clock.advance(1);

    const down = await unpublishAnnouncement(test.ctx, made.id);
    if (typeof down !== "object" || !("id" in down)) throw new Error("Not taken down");
    assertEquals(down, { ...made, published_at: null, updated_at: test.clock.now() });
    assertEquals(await unpublishAnnouncement(test.ctx, made.id), down);

    // Taking down a scheduled one keeps it from being published when due.
    assertEquals(await unpublishAnnouncement(test.ctx, scheduled.id), {
        ...scheduled,
        scheduled_at: null,
        updated_at: test.clock.now(),
    });
    test.clock.advance(minute);
    await publishDueAnnouncements(test.ctx);
    assertEquals(await test.published(), []);

    const up = await publishAnnouncement(test.ctx, made.id);
    assertEquals(up, { ...down, published_at: test.clock.now(), updated_at: test.clock.now() });
    assertEquals(await publishAnnouncement(test.ctx, made.id), up);
    assertEquals([
        await publishAnnouncement(test.ctx, "x"),
        await unpublishAnnouncement(test.ctx, "x"),
    ], ["missing", "missing"]);
    assertEquals(test.heard, [
        { id: made.id, published: true },
        { id: made.id, published: false },
        { id: made.id, published: true },
    ]);
});

Deno.test("deleting a published announcement tells apps, and a draft's doesn't", async () => {
    await using test = await open();
    const made = await announce(test.ctx, "Hi");
    const draft = await announce(test.ctx, "Later", { scheduledAt: test.later(minute) });

    assertEquals(await removeAnnouncement(test.ctx, made.id), true);
    assertEquals(await removeAnnouncement(test.ctx, draft.id), true);
    assertEquals(await removeAnnouncement(test.ctx, made.id), false);
    assertEquals(test.heard, [
        { id: made.id, published: true },
        { id: made.id, published: false },
    ]);
});

Deno.test("only published announcements are dismissed", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "alice");
    const made = await announce(test.ctx, "Hi");
    const draft = await announce(test.ctx, "Later", { scheduledAt: test.later(minute) });

    assertEquals(await dismissAnnouncement(test.ctx, "alice", made.id), true);
    assertEquals(await dismissAnnouncement(test.ctx, "alice", made.id), true);
    assertEquals(await dismissAnnouncement(test.ctx, "alice", draft.id), false);
    assertEquals(await dismissAnnouncement(test.ctx, "alice", "x"), false);
});

Deno.test("reactions are rendered with whether the viewer made them, but not for no viewer", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "alice");
    const made = await announce(test.ctx, "Hi");
    await reactToAnnouncement(test.ctx, "alice", made.id, "👍");

    const reactions = async (viewerId: string | null) =>
        (await renderAnnouncements(test.ctx, [made], viewerId))[0].reactions;
    assertEquals(await reactions("alice"), [{ name: "👍", count: 1, me: true }]);
    assertEquals(await reactions(null), [{ name: "👍", count: 1 }]);
});
