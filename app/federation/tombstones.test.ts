import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { dropDeliveriesOf, queueDeliveriesTo } from "./deliver.ts";
import { fanOut } from "./testing.ts";
import { deleteExpiredTombstones, isDeleted, queueDelete } from "./tombstones.ts";

const day = 24 * 3_600_000;
const noteType = "pub.versia:social/Note";

const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");

    /** The stored entities, as their id, or their type if they have none. */
    const bodies = async () =>
        (await test.ctx.db.selectFrom("delivery_bodies").select("body").orderBy("id").execute())
            .map((row) => JSON.parse(row.body)).map((entity) => entity.id ?? entity.type);

    return { ...test, bodies };
};

Deno.test("a delete is remembered, its entity's queued deliveries are dropped, and the Delete is queued", async () => {
    await using test = await open();
    const audience = { instanceIds: ["b.example"] };
    const note = (id: string) => ({ type: noteType, id, author: "social.example:alice" });
    await queueDeliveriesTo(test.ctx, note("n1"), audience);
    await queueDeliveriesTo(test.ctx, note("n1"), audience);
    await queueDeliveriesTo(test.ctx, note("n2"), audience);

    await queueDelete(test.ctx, "alice", noteType, "n1", audience);

    assertEquals(await test.bodies(), ["n2", "Delete"]);
    assertEquals(await isDeleted(test.ctx, noteType, "n1"), true);
    assertEquals(await isDeleted(test.ctx, noteType, "n2"), false);

    // The Delete is sent, though its entity's own deliveries aren't.
    await fanOut(test.ctx);
    const jobs = await test.ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", "versia-deliver").execute();
    assertEquals(jobs.length, 2);
});

Deno.test("a delete to nobody is still remembered, and drops what was queued", async () => {
    await using test = await open();
    await queueDeliveriesTo(
        test.ctx,
        { type: noteType, id: "n1", author: "social.example:alice" },
        { instanceIds: ["b.example"] },
    );

    await queueDelete(test.ctx, "alice", noteType, "n1", { instanceIds: [] });

    assertEquals(await test.bodies(), []);
    assertEquals(await isDeleted(test.ctx, noteType, "n1"), true);
});

Deno.test("deleting an entity again keeps its first tombstone", async () => {
    await using test = await open();
    const deleted = async () =>
        await test.ctx.db.selectFrom("deleted_entities").selectAll().execute();

    await queueDelete(test.ctx, "alice", noteType, "n1", { instanceIds: [] });
    const first = await deleted();
    test.clock.advance(day);
    await queueDelete(test.ctx, "alice", noteType, "n1", { instanceIds: [] });

    assertEquals(first.length, 1);
    assertEquals(await deleted(), first);
});

Deno.test("an entity is only deleted as the type it was deleted as", async () => {
    await using test = await open();

    await queueDelete(test.ctx, "alice", "pub.versia:likes/Like", "l1", { instanceIds: [] });

    assertEquals(await isDeleted(test.ctx, "pub.versia:likes/Like", "l1"), true);
    assertEquals(await isDeleted(test.ctx, noteType, "l1"), false);
});

Deno.test("dropping the deliveries of an entity that has none changes nothing", async () => {
    await using test = await open();
    await queueDeliveriesTo(test.ctx, { type: "Thing" }, { instanceIds: ["b.example"] });

    await dropDeliveriesOf(test.ctx, "n1");

    assertEquals(await test.bodies(), ["Thing"]);
});

Deno.test("tombstones are kept for 30 days, and removed a batch at a time", async () => {
    await using test = await open();
    const ids = async () =>
        (await test.ctx.db.selectFrom("deleted_entities").select("id").orderBy("id").execute())
            .map((row) => row.id);
    for (const id of ["a", "b", "c"]) {
        await queueDelete(test.ctx, "alice", noteType, id, { instanceIds: [] });
    }
    test.clock.advance(day);
    await queueDelete(test.ctx, "alice", noteType, "d", { instanceIds: [] });

    test.clock.advance(29 * day - 1);
    await deleteExpiredTombstones(test.ctx);
    assertEquals(await ids(), ["a", "b", "c", "d"]);

    test.clock.advance(1);
    await deleteExpiredTombstones(test.ctx, 2);
    assertEquals(await ids(), ["d"]);
});
