import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import { blockDomain } from "../moderation/domain_blocks.ts";
import { addEvilInstance } from "../testing/evil.ts";
import { createNetwork } from "../testing/network.ts";
import { backfillHandler, backfillLater, type BackfillLimits, fetchReplies } from "./backfill.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { createNote } from "./testing.ts";
import { threadOf } from "./threads.ts";
import { totalsQueue } from "./totals.ts";

/**
 * a.test, with alice, who follows no one, and b.test, with bob's status `root`, carol's reply to
 * it, and dave's reply to carol's, which a.test never hears of unless it fetches them.
 */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const alice = await createLocalAccount(a, "alice");
    for (const name of ["bob", "carol", "dave"]) await createLocalAccount(b, name);

    const root = await createNote(b, "bob");
    const reply = async (to: NoteRow, by = "carol") =>
        await createNote(b, by, { in_reply_to_id: to.id, in_reply_to_account_id: to.account_id });
    const carols = await reply(root);
    const daves = await reply(carols, "dave");

    const rootId = await a.federation.resolve(a, { host: "b.test", id: root.id }, "Note");
    assertExists(rootId);
    const copy = await findNote(a, rootId);
    assertExists(copy);

    /** The ids on b.test of the statuses under `copy` that a.test has. */
    const under = async () =>
        (await threadOf(a, copy, alice)).descendants.map((note) => note.remote_id);

    /** Makes b.test answer `answer` for the replies of its status `id`. */
    const failing = (id: string, answer: () => Response) => {
        const serve = network.transport.servers.get("b.test");
        assertExists(serve);
        network.transport.servers.set("b.test", (request) =>
            new URL(request.url).pathname ===
                    `/.versia/v0.6/entities/Note/${id}/collections/replies`
                ? Promise.resolve(answer())
                : serve(request));
    };

    /** How many pages of the replies of b.test's status `id` a.test asked for. */
    const asked = (id: string) =>
        network.transport.sent.filter((request) =>
            new URL(request.url).pathname ===
                `/.versia/v0.6/entities/Note/${id}/collections/replies`
        ).length;

    return {
        network,
        a,
        b,
        alice,
        root,
        carols,
        daves,
        copy,
        reply,
        under,
        failing,
        asked,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a user opening a remote thread has the replies under it fetched, but no one else", async () => {
    await using test = await open();
    const app = test.network.instances["a.test"].app;
    const token = await tokenFor(test.a, test.alice);
    const opened = async (as: string | null) => {
        const response = await app.request(`/api/v1/statuses/${test.copy.id}/context`, {
            headers: as === null ? {} : { authorization: `Bearer ${as}` },
        });
        assertEquals(response.status, 200);
        await response.body?.cancel();
        await test.network.drain();
        return await test.under();
    };
    test.network.clock.advance(5 * 60_000);

    assertEquals(await opened(null), []);
    assertEquals(await opened(token), [test.carols.id, test.daves.id]);
});

Deno.test("only remote public and unlisted statuses 5 minutes old have their replies fetched", async () => {
    await using test = await open();
    const visible = (visibility: NoteRow["visibility"]) => ({ ...test.copy, visibility });

    test.network.clock.advance(5 * 60_000 - 1);
    assertEquals(await backfillLater(test.a, test.copy), false);
    test.network.clock.advance(1);
    assertEquals(await backfillLater(test.a, visible("private")), false);
    assertEquals(await backfillLater(test.a, visible("direct")), false);
    assertEquals(await backfillLater(test.a, await createNote(test.a, test.alice)), false);
    assertEquals(await backfillLater(test.a, visible("unlisted")), true);
    assertEquals(await backfillLater(test.a, test.copy), true);
    await test.network.drain();
    assertEquals(await test.under(), [test.carols.id, test.daves.id]);

    test.network.clock.advance(15 * 60_000 - 1);
    assertEquals(await backfillLater(test.a, test.copy), false);
    test.network.clock.advance(1);
    assertEquals(await backfillLater(test.a, test.copy), true);
});

Deno.test("the start of a thread has its replies fetched each time, and others every 15 minutes", async () => {
    await using test = await open();
    await fetchReplies(test.a, test.copy);

    const newer = await test.reply(test.root);
    const later = await test.reply(test.carols);
    await fetchReplies(test.a, test.copy);
    assertEquals(await test.under(), [test.carols.id, test.daves.id, newer.id]);

    test.network.clock.advance(15 * 60_000);
    await fetchReplies(test.a, test.copy);
    assertEquals(await test.under(), [test.carols.id, test.daves.id, later.id, newer.id]);
});

Deno.test("a status's replies are fetched 15 minutes after they were last fetched", async () => {
    await using test = await open();
    await fetchReplies(test.a, test.copy);
    test.network.clock.advance(20 * 60_000);
    await fetchReplies(test.a, test.copy);

    test.network.clock.advance(10 * 60_000);
    await fetchReplies(test.a, test.copy);
    assertEquals(test.asked(test.carols.id), 2);
});

Deno.test("replies fetched to backfill have their totals fetched only when opened", async () => {
    await using test = await open();
    await fetchReplies(test.a, test.copy);

    const jobs = await test.a.db.selectFrom("jobs").select("payload")
        .where("queue", "=", totalsQueue)
        .execute();
    assertEquals(jobs.map((job) => job.payload), [{ noteId: test.copy.id }]);
});

Deno.test("replies stored are fetched again only once they are a week old", async () => {
    await using test = await open();
    const fetches = () =>
        test.network.transport.sent.filter((request) => {
            const path = new URL(request.url).pathname;
            return path.startsWith("/.versia/v0.6/entities/Note/") &&
                !path.includes("/collections/");
        }).length;
    await fetchReplies(test.a, test.copy);

    const from = fetches();
    test.network.clock.advance(7 * 24 * 60 * 60_000 - 1);
    await fetchReplies(test.a, test.copy);
    assertEquals(fetches() - from, 0);
    test.network.clock.advance(15 * 60_000 + 1);
    await fetchReplies(test.a, test.copy);
    // carol's and dave's replies, and the status carol's replies to, which is over a day old.
    assertEquals(fetches() - from, 3);
});

Deno.test("replies are fetched up to so many statuses and pages", async () => {
    const fetchedWith = async (max: BackfillLimits) => {
        await using test = await open();
        await test.reply(test.daves);
        await fetchReplies(test.a, test.copy, max);
        return (await test.under()).length;
    };

    assertEquals(await fetchedWith({ replies: 2, pages: 500 }), 2);
    assertEquals(await fetchedWith({ replies: 3, pages: 500 }), 3);
    assertEquals(await fetchedWith({ replies: 1000, pages: 2 }), 2);
    assertEquals(await fetchedWith({ replies: 1000, pages: 3 }), 3);
});

Deno.test("replies stop being fetched midway through a page once there are enough", async () => {
    await using test = await open();
    await test.reply(test.root);

    await fetchReplies(test.a, test.copy, { replies: 1, pages: 500 });
    assertEquals((await test.under()).length, 1);
    assertEquals(test.asked(test.carols.id), 0);
});

Deno.test("a status deleted before its replies are fetched has none fetched", async () => {
    await using test = await open();
    const job = { payload: { noteId: "gone" } } as unknown as JobsTable;

    await backfillHandler(test.a, job);
    assertEquals(test.asked(test.root.id), 0);
});

Deno.test("replies are fetched page by page", async () => {
    await using test = await open();
    for (let count = 0; count < 40; count++) await test.reply(test.root, "dave");

    await fetchReplies(test.a, test.copy);
    assertEquals((await test.under()).length, 42);
    assertEquals(test.asked(test.root.id), 2);
});

Deno.test("replies are fetched for 4 minutes at most", async () => {
    await using test = await open();
    for (let count = 0; count < 40; count++) await test.reply(test.root, "dave");
    const serve = test.network.transport.servers.get("b.test");
    assertExists(serve);
    test.network.transport.servers.set("b.test", (request) => {
        if (request.url.includes("/collections/replies")) test.network.clock.advance(4 * 60_000);
        return serve(request);
    });

    await fetchReplies(test.a, test.copy);
    assertEquals(test.asked(test.root.id), 1);
});

Deno.test("no replies are fetched from a blocked instance", async () => {
    await using test = await open();
    await blockDomain(test.a, "b.test");

    await fetchReplies(test.a, test.copy);
    assertEquals(test.asked(test.root.id), 0);
});

Deno.test("failing to fetch the replies of a thread's start fails, unless it has none, but of a reply only skips it", async () => {
    await using test = await open();
    test.failing(test.root.id, () => new Response(null, { status: 500 }));
    await assertRejects(() => fetchReplies(test.a, test.copy));
    assertEquals(await test.under(), []);

    const evil = await addEvilInstance(test.network, "e.test");
    evil.serve("/.versia/v0.6/entities/User/eve", {
        type: "User",
        id: "eve",
        created_at: "2026-01-01T00:00:00Z",
        username: "eve",
        fields: [],
        manually_approves_followers: false,
        indexable: true,
    });
    evil.serve("/.versia/v0.6/entities/Note/n1", {
        type: "Note",
        id: "n1",
        created_at: "2026-01-01T00:00:00Z",
        author: "eve",
        content: { "text/plain": { content: "Hi", remote: false } },
        group: "public",
        is_sensitive: false,
        mentions: [],
        attachments: [],
        previews: [],
    });
    const evils = await test.a.federation.resolve(test.a, { host: "e.test", id: "n1" }, "Note");
    assertExists(evils);
    const evilsRow = await findNote(test.a, evils);
    assertExists(evilsRow);
    await fetchReplies(test.a, evilsRow);
    const serve = test.network.transport.servers.get("e.test");
    assertExists(serve);
    test.network.transport.servers.set("e.test", (request) =>
        request.url.includes("/collections/replies")
            ? Promise.resolve(new Response(null, { status: 410 }))
            : serve(request));
    await fetchReplies(test.a, evilsRow);
    test.network.transport.servers.set("e.test", serve);
    evil.serve("/.versia/v0.6/entities/Note/n1/collections/replies", { total: 1 });
    await assertRejects(() => fetchReplies(test.a, evilsRow), PermanentFailure);
    evil.serve("/.versia/v0.6/entities/Note/n1/collections/replies", "{");
    await assertRejects(() => fetchReplies(test.a, evilsRow), PermanentFailure);

    await using fresh = await open();
    const newer = await fresh.reply(fresh.root);
    fresh.failing(newer.id, () => Response.json({ total: 1 }));
    await fetchReplies(fresh.a, fresh.copy);
    assertEquals(await fresh.under(), [fresh.carols.id, fresh.daves.id, newer.id]);
});
