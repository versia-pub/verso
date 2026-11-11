import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { createNetwork } from "../testing/network.ts";
import { contextRefresh, countResults, finishRefresh, startRefresh } from "./async_refreshes.ts";
import { backfillHandler, backfillLater } from "./backfill.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { createNote } from "./testing.ts";

/**
 * a.test, with alice, and b.test, with bob's status `root` and carol's reply to it, which a.test
 * has only `root` of, as `copy`, 5 minutes old.
 */
const open = async () => {
    const network = await createNetwork(["a.test", "b.test"]);
    const a = network.instances["a.test"].ctx;
    const b = network.instances["b.test"].ctx;
    const app = network.instances["a.test"].app;
    const alice = await createLocalAccount(a, "alice");
    for (const name of ["bob", "carol"]) await createLocalAccount(b, name);

    const root = await createNote(b, "bob");
    const reply = async (to: NoteRow) =>
        await createNote(b, "carol", {
            in_reply_to_id: to.id,
            in_reply_to_account_id: to.account_id,
        });
    await reply(root);

    const rootId = await a.federation.resolve(a, { host: "b.test", id: root.id }, "Note");
    assertExists(rootId);
    const copy = await findNote(a, rootId);
    assertExists(copy);
    const token = await tokenFor(a, alice);
    network.clock.advance(5 * 60_000);

    /** The `Mastodon-Async-Refresh` header of the context of `copy`, as `as` sees it. */
    const opened = async (as: string | null = token) => {
        const response = await app.request(`/api/v1/statuses/${copy.id}/context`, {
            headers: as === null ? {} : { authorization: `Bearer ${as}` },
        });
        assertEquals(response.status, 200);
        await response.body?.cancel();
        return response.headers.get("mastodon-async-refresh");
    };

    /** What a.test answers for the refresh `id`, as `as`. */
    const refresh = async (id = contextRefresh(copy.id), as: string | null = token) => {
        const response = await app.request(`/api/v1_alpha/async_refreshes/${id}`, {
            headers: as === null ? {} : { authorization: `Bearer ${as}` },
        });
        const body = await response.json();
        return response.status === 200 ? body.async_refresh : response.status;
    };

    return {
        network,
        a,
        root,
        copy,
        reply,
        opened,
        refresh,
        [Symbol.asyncDispose]: network[Symbol.asyncDispose],
    };
};

Deno.test("a thread whose replies are being fetched says so until they are, with how many are new", async () => {
    await using test = await open();
    const id = contextRefresh(test.copy.id);
    await test.reply(test.root);

    assertEquals(await test.opened(), `id="${id}", retry=3, result_count=0`);
    assertEquals(await test.opened(null), `id="${id}", retry=3, result_count=0`);
    assertEquals(await test.refresh(), { id, status: "running", result_count: 0 });

    await test.network.drain();
    assertEquals(await test.refresh(), { id, status: "finished", result_count: 2 });
    assertEquals(await test.opened(), null);

    test.network.clock.advance(15 * 60_000);
    await test.reply(test.root);
    assertEquals(await test.opened(), `id="${id}", retry=3, result_count=0`);
    assertEquals(await test.refresh(), { id, status: "running", result_count: 0 });
    await test.network.drain();
    assertEquals(await test.refresh(), { id, status: "finished", result_count: 1 });
});

Deno.test("a refresh is started before its job, which finishes it", async () => {
    await using test = await open();
    const id = contextRefresh(test.copy.id);
    assertEquals(await backfillLater(test.a, test.copy), {
        id,
        started_at: test.network.clock.now(),
        finished_at: null,
        result_count: 0,
    });

    await test.network.drain();
    assertEquals(await test.refresh(encodeURIComponent(id)), {
        id,
        status: "finished",
        result_count: 1,
    });
});

Deno.test("opening a thread again while its replies are fetched leaves the refresh as it is", async () => {
    await using test = await open();
    const id = contextRefresh(test.copy.id);
    await test.opened();
    await countResults(test.a, id, 1);

    assertEquals(await test.opened(), `id="${id}", retry=3, result_count=1`);
});

Deno.test("only a user opening a thread has its replies fetched, and only users see how it goes", async () => {
    await using test = await open();

    assertEquals(await test.opened(null), null);
    assertEquals(await test.refresh(), 404);
    assertEquals(
        await test.opened(),
        `id="${contextRefresh(test.copy.id)}", retry=3, result_count=0`,
    );
    assertEquals(await test.refresh(undefined, null), 401);
    assertEquals(await test.refresh("context:other"), 404);
});

Deno.test("a refresh is kept for a day while it runs, and for an hour once it finished", async () => {
    await using test = await open();
    const kept = async () =>
        (await test.a.db.selectFrom("async_refreshes").select("id").orderBy("id").execute())
            .map((row) => row.id);
    await startRefresh(test.a, "running");
    await startRefresh(test.a, "finished");
    await finishRefresh(test.a, "finished");
    test.network.clock.advance(30 * 60_000);
    await finishRefresh(test.a, "finished");

    test.network.clock.advance(30 * 60_000 - 1);
    assertEquals((await test.refresh("finished")).status, "finished");
    test.network.clock.advance(1);
    assertEquals(await test.refresh("finished"), 404);
    await startRefresh(test.a, "later");
    assertEquals(await kept(), ["later", "running"]);

    test.network.clock.advance(23 * 60 * 60_000 - 1);
    assertEquals((await test.refresh("running")).status, "running");
    test.network.clock.advance(1);
    assertEquals(await test.refresh("running"), 404);
    await startRefresh(test.a, "new");
    assertEquals(await kept(), ["later", "new"]);
});

Deno.test("a refresh started again is kept for a day from then, as running", async () => {
    await using test = await open();
    await startRefresh(test.a, "again");
    await finishRefresh(test.a, "again");
    test.network.clock.advance(50 * 60_000);

    await startRefresh(test.a, "again");
    test.network.clock.advance(23 * 60 * 60_000 + 59 * 60_000);
    assertEquals((await test.refresh("again")).status, "running");
});

Deno.test("a refresh finishes even when its fetch fails", async () => {
    await using test = await open();
    const serve = test.network.transport.servers.get("b.test");
    assertExists(serve);
    test.network.transport.servers.set("b.test", (request) =>
        request.url.includes("/collections/replies")
            ? Promise.resolve(new Response(null, { status: 500 }))
            : serve(request));
    await startRefresh(test.a, contextRefresh(test.copy.id));

    const job = { payload: { noteId: test.copy.id } } as unknown as JobsTable;
    await assertRejects(() => backfillHandler(test.a, job));
    assertEquals((await test.refresh()).status, "finished");
});
