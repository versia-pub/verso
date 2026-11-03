import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { JobsTable } from "../jobs/tables.ts";
import type { Context } from "../kernel/context.ts";
import { createNote, createShare } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { insertPoll } from "./poll_queries.ts";
import { pollRefreshHandler, pollRefreshQueue, refreshPoll, staleMs } from "./refreshing.ts";

const hour = 3600_000;

/** carol's remote status `q1` with a poll, fetched `ageMs` ago, which ends in `endsInMs`. */
const open = async (ageMs: number, endsInMs: number | null = hour) => {
    const resolved: unknown[] = [];
    const test = await createTestContext({
        federation: {
            resolve: (_ctx: Context, reference: unknown) => {
                resolved.push(reference);
                return Promise.resolve(undefined);
            },
        },
    });
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "carol", await createInstance(test.ctx, "b.example"));

    const now = test.clock.now().getTime();
    const note = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "q1",
        fetched_at: new Date(now - ageMs),
    });
    await insertPoll(test.ctx, note.id, {
        options: ["Red", "Blue"],
        multiple: false,
        hideTotals: false,
        expiresAt: endsInMs === null ? null : new Date(now + endsInMs),
    });

    /** The refreshes queued, with their groups. */
    const queued = async () =>
        (await test.ctx.db.selectFrom("jobs").select(["payload", "group_key"])
            .where("queue", "=", pollRefreshQueue).execute())
            .map((job) => [job.payload, job.group_key]);

    return { ...test, note, resolved, queued };
};

Deno.test("a poll is refreshed once it is a minute old, with one job for the instance", async () => {
    await using young = await open(staleMs - 1);
    await refreshPoll(young.ctx, young.note.id);
    assertEquals(await young.queued(), []);

    await using test = await open(staleMs);
    await refreshPoll(test.ctx, test.note.id);
    await refreshPoll(test.ctx, test.note.id);
    assertEquals(await test.queued(), [[{ noteId: test.note.id }, "b.example"]]);
});

Deno.test("a poll is refreshed until it ends, or until what was fetched is from after it", async () => {
    await using never = await open(hour, null);
    await refreshPoll(never.ctx, never.note.id);
    assertEquals((await never.queued()).length, 1);

    // What was fetched when the poll ended is final, as is what was fetched later.
    await using ended = await open(hour, -hour);
    await refreshPoll(ended.ctx, ended.note.id);
    assertEquals(await ended.queued(), []);

    await using at = await open(hour, -hour);
    await at.ctx.db.updateTable("notes").set({
        fetched_at: new Date(at.clock.now().getTime() - hour),
    })
        .where("id", "=", at.note.id).execute();
    await refreshPoll(at.ctx, at.note.id);
    assertEquals(await at.queued(), []);

    // Fetched a minute before it ended, it may have changed since.
    await at.ctx.db.updateTable("notes").set({
        fetched_at: new Date(at.clock.now().getTime() - hour - staleMs),
    }).where("id", "=", at.note.id).execute();
    await refreshPoll(at.ctx, at.note.id);
    assertEquals((await at.queued()).length, 1);
});

Deno.test("a local status, a boost, a status without a poll and a missing one aren't refreshed", async () => {
    await using test = await open(hour);
    const local = await createNote(test.ctx, "alice", { fetched_at: new Date(0) });
    await insertPoll(test.ctx, local.id, {
        options: ["Red", "Blue"],
        multiple: false,
        hideTotals: false,
        expiresAt: null,
    });
    const boost = await createShare(test.ctx, "alice", test.note.id, {
        instance_id: "b.example",
        remote_id: "s1",
        fetched_at: new Date(0),
    });
    const plain = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "q2",
        fetched_at: new Date(0),
    });

    for (const id of [local.id, boost.id, plain.id, "missing"]) await refreshPoll(test.ctx, id);

    assertEquals(await test.queued(), []);
});

Deno.test("the job fetches the status again, unless its poll isn't stale by then", async () => {
    await using test = await open(staleMs);
    const job = (noteId: string) => ({ payload: { noteId } }) as unknown as JobsTable;

    await pollRefreshHandler(test.ctx, job(test.note.id));
    assertEquals(test.resolved, [{ host: "b.example", id: "q1" }]);

    // The status was received since the job was queued.
    await test.ctx.db.updateTable("notes").set({ fetched_at: test.clock.now() })
        .where("id", "=", test.note.id).execute();
    await pollRefreshHandler(test.ctx, job(test.note.id));
    await pollRefreshHandler(test.ctx, job("missing"));

    assertEquals(test.resolved.length, 1);
});
