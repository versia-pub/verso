import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { defaultSettings } from "../instances/testing.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { noteRoutes } from "../notes/routes.ts";
import { removeNote } from "../notes/removal.ts";
import { createNote } from "../notes/testing.ts";
import { pollOf } from "../polls/poll_queries.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { publishDue, scheduledNotesQueue } from "./publishing.ts";
import { scheduledRoutes } from "./routes.ts";
import type { ScheduledParams } from "./tables.ts";

const minute = 60_000;
const day = 24 * 60 * minute;

/** alice and bob, local users. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(
        test.ctx,
        [...noteRoutes(defaultSettings().limits), ...scheduledRoutes],
        { checkResponses: true },
    );
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);

    /** Sends a request as `as`, in JSON. */
    const request = async (
        method: string,
        path: string,
        body?: Record<string, unknown>,
        as = "alice",
    ) => {
        const response = await app.request(path, {
            method,
            headers: {
                authorization: `Bearer ${await tokenFor(test.ctx, as)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

        return {
            status: response.status,
            body: await response.json(),
            link: response.headers.get("link"),
        };
    };

    /** The time `ms` from now. */
    const inMs = (ms: number) => new Date(test.clock.now().getTime() + ms).toISOString();

    /** Has `as` schedule `body` for `at`. */
    const schedule = (at: string, body: Record<string, unknown> = {}, as = "alice") =>
        request("POST", "/api/v1/statuses", { status: "Later", ...body, scheduled_at: at }, as);

    /** Posts the scheduled statuses that are due, at the time `ms` from now. */
    const publish = async (ms: number) => {
        test.clock.advance(ms);
        await publishDue(test.ctx);
    };

    /** Adds scheduled statuses of alice's for `times`, unchecked, with `params` if given. */
    const insert = async (times: readonly Date[], params: Partial<ScheduledParams> = {}) => {
        await test.ctx.db.insertInto("scheduled_notes")
            .values(times.map((at) => ({
                id: test.ctx.ids(),
                account_id: "alice",
                scheduled_at: at,
                params: {
                    text: "Later",
                    content_type: "text/plain" as const,
                    spoiler_text: "",
                    sensitive: null,
                    visibility: null,
                    language: null,
                    in_reply_to_id: null,
                    media_ids: null,
                    poll: null,
                    ...params,
                },
                created_at: test.clock.now(),
            })))
            .execute();
    };

    const posted = () =>
        test.ctx.db.selectFrom("notes").selectAll().where("account_id", "=", "alice")
            .orderBy("id").execute();

    return { ...test, request, inMs, schedule, publish, insert, posted };
};

Deno.test("a status scheduled for later is kept, with what it will be posted with", async () => {
    await using test = await open();
    const at = test.inMs(60 * minute);

    const scheduled = await test.schedule(at, {
        spoiler_text: "Soon",
        poll: { options: ["Yes", "No"], expires_in: 3600, multiple: true, hide_totals: true },
    });

    assertEquals(scheduled.status, 200);
    assertEquals(scheduled.body, {
        id: scheduled.body.id,
        scheduled_at: at,
        params: {
            text: "Later",
            content_type: "text/plain",
            spoiler_text: "Soon",
            sensitive: null,
            visibility: null,
            language: null,
            in_reply_to_id: null,
            media_ids: null,
            poll: { options: ["Yes", "No"], expires_in: 3600, multiple: true, hide_totals: true },
            scheduled_at: null,
            idempotency: null,
            with_rate_limit: false,
        },
        media_attachments: [],
    });
    assertEquals(await test.posted(), []);

    const path = `/api/v1/scheduled_statuses/${scheduled.body.id}`;
    assertEquals((await test.request("GET", path)).body, scheduled.body);
    assertEquals((await test.request("GET", "/api/v1/scheduled_statuses")).body, [scheduled.body]);
    // Only to its author.
    assertEquals((await test.request("GET", path, undefined, "bob")).status, 404);
    assertEquals(
        (await test.request("GET", "/api/v1/scheduled_statuses", undefined, "bob")).body,
        [],
    );
});

Deno.test("a time already past posts now, but one less than 5 minutes ahead is refused", async () => {
    await using test = await open();

    const now = await test.schedule(test.inMs(-1));
    assertEquals([now.status, now.body.content], [200, "<p>Later</p>"]);

    const soon = await test.schedule(test.inMs(5 * minute));
    assertEquals([soon.status, soon.body.error_description], [
        422,
        "The scheduled date must be in the future",
    ]);
    assertEquals((await test.schedule(test.inMs(5 * minute + 1))).status, 200);
});

Deno.test("a reply to a status its author can't see, or with media, can't be scheduled", async () => {
    await using test = await open();
    const hidden = await createNote(test.ctx, "bob", { visibility: "direct" });

    const reply = await test.schedule(test.inMs(day), { in_reply_to_id: hidden.id });
    assertEquals(reply.status, 404);

    const media = await test.schedule(test.inMs(day), { media_ids: ["m1"] });
    assertEquals([media.status, media.body.error_description], [
        422,
        "Scheduled statuses can't have media yet",
    ]);
    assertEquals((await test.request("GET", "/api/v1/scheduled_statuses")).body, []);
});

Deno.test("an account may schedule 25 statuses a day, in UTC, and 300 in all", async () => {
    await using test = await open();
    const midnight = Math.ceil((test.clock.now().getTime() + day) / day) * day;
    const at = (ms: number) => new Date(midnight + ms).toISOString();
    for (let i = 0; i < 24; i++) assertEquals((await test.schedule(at(i * minute))).status, 200);

    assertEquals((await test.schedule(at(day - 1))).status, 200);
    const over = await test.schedule(at(day - 1));
    assertEquals([over.status, over.body.error_description], [
        422,
        "You have exceeded the limit of 25 scheduled posts for today",
    ]);
    assertEquals((await test.schedule(at(day))).status, 200);
    assertEquals((await test.schedule(at(-1))).status, 200);
    // bob has his own.
    assertEquals((await test.schedule(at(0), {}, "bob")).status, 200);

    await test.insert(
        [...Array(273).keys()].map((i) => new Date(midnight + (2 + Math.floor(i / 20)) * day)),
    );
    const full = await test.schedule(at(100 * day));
    assertEquals([full.status, full.body.error_description], [
        422,
        "You have exceeded the limit of 300 scheduled posts",
    ]);
});

Deno.test("a scheduled status is moved within the limits, not counting itself, or cancelled", async () => {
    await using test = await open();
    const midnight = Math.ceil((test.clock.now().getTime() + day) / day) * day;
    const at = (ms: number) => new Date(midnight + ms).toISOString();
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push((await test.schedule(at(i * minute))).body.id);
    const path = `/api/v1/scheduled_statuses/${ids[0]}`;

    const moved = await test.request("PUT", path, { scheduled_at: at(60 * minute) });
    assertEquals([moved.status, moved.body.scheduled_at], [200, at(60 * minute)]);
    assertEquals((await test.request("GET", path)).body.scheduled_at, at(60 * minute));
    const soon = await test.request("PUT", path, { scheduled_at: test.inMs(minute) });
    assertEquals([soon.status, soon.body.error_description], [
        422,
        "The scheduled date must be in the future",
    ]);
    assertEquals((await test.request("PUT", path, { scheduled_at: at(day) }, "bob")).status, 404);
    assertEquals((await test.request("DELETE", path, undefined, "bob")).status, 404);

    assertEquals(await test.request("DELETE", path), { status: 200, body: {}, link: null });
    assertEquals((await test.request("GET", path)).status, 404);
    assertEquals((await test.request("DELETE", path)).status, 404);
});

Deno.test("scheduled statuses are listed by id, the last scheduled first, in pages", async () => {
    await using test = await open();
    const first = (await test.schedule(test.inMs(2 * day))).body.id;
    const second = (await test.schedule(test.inMs(day))).body.id;

    const page = await test.request("GET", "/api/v1/scheduled_statuses?limit=1");
    assertEquals(page.body.map((each: { id: string }) => each.id), [second]);
    assertEquals(page.link?.includes(`max_id=${second}`), true);

    const next = await test.request("GET", `/api/v1/scheduled_statuses?max_id=${second}`);
    assertEquals(next.body.map((each: { id: string }) => each.id), [first]);
});

Deno.test("a scheduled status is posted once when due, with its author's defaults then", async () => {
    await using test = await open();
    const poll = { options: ["Yes", "No"], expires_in: 600 };
    await test.schedule(test.inMs(60 * minute), { poll, language: "de" });
    await test.schedule(test.inMs(120 * minute), { status: "Later still" });

    await test.publish(60 * minute - 1);
    assertEquals(await test.posted(), []);

    await test.ctx.db.updateTable("accounts").set({ default_visibility: "private" })
        .where("id", "=", "alice").execute();
    await test.publish(1);
    await test.publish(0);

    const [note] = await test.posted();
    assertEquals(await test.posted().then((notes) => notes.length), 1);
    assertEquals([note.content, note.visibility, note.language], ["Later", "private", "de"]);
    // Its poll runs from when it is posted.
    assertEquals(
        (await pollOf(test.ctx, note.id))?.expires_at,
        new Date(test.clock.now().getTime() + 600_000),
    );
    assertEquals(
        (await test.request("GET", "/api/v1/scheduled_statuses")).body.map((
            each: { params: { text: string } },
        ) => each.params.text),
        ["Later still"],
    );
});

Deno.test("all that is due is posted, once, however many are due and post at once", async () => {
    await using test = await open();
    await test.insert([...Array(101).keys()].map(() => new Date(test.inMs(minute))));

    test.clock.advance(minute);
    await Promise.all([publishDue(test.ctx), publishDue(test.ctx)]);

    assertEquals((await test.posted()).length, 101);
});

Deno.test("a scheduled status that can't be posted any more is dropped", async () => {
    await using test = await open();
    // As media that was deleted since.
    await test.insert([new Date(test.inMs(minute))], { media_ids: ["gone"] });

    await test.publish(minute);

    assertEquals(await test.posted(), []);
    assertEquals((await test.request("GET", "/api/v1/scheduled_statuses")).body, []);
});

Deno.test("a scheduled reply to a status since deleted is dropped", async () => {
    await using test = await open();
    const parent = await createNote(test.ctx, "bob");
    await test.schedule(test.inMs(day), { in_reply_to_id: parent.id });
    await removeNote(test.ctx, parent.id);

    await test.publish(day);

    assertEquals(await test.posted(), []);
    assertEquals((await test.request("GET", "/api/v1/scheduled_statuses")).body, []);
});

Deno.test("statuses that are due are posted every minute", () => {
    assertEquals(tasks.filter((task) => task.queue === scheduledNotesQueue), [
        { queue: scheduledNotesQueue, every: "minute" },
    ]);
    assertEquals(queues[scheduledNotesQueue].concurrency, 1);
});
