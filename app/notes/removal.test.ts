import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { fetchBudget } from "../federation/resolver.ts";
import { createInstance } from "../instances/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { findNote } from "./note_queries.ts";
import { countPosted } from "./notes.ts";
import { createNote, createShare } from "./testing.ts";

/**
 * alice and carol here, and bob on b.example, who replies to and shares alice's note, and has many
 * notes of his own, one of which carol shares.
 */
const open = async () => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "carol");
    const instanceId = await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "bob", instanceId);

    const hers = await createNote(test.ctx, "alice");
    const reply = await createNote(test.ctx, "bob", {
        instance_id: instanceId,
        remote_id: "reply",
        in_reply_to_id: hers.id,
        in_reply_to_account_id: "alice",
    });
    await countPosted(test.ctx, reply, 1);
    await createShare(test.ctx, "bob", hers.id, { instance_id: instanceId, remote_id: "share" });
    for (let n = 0; n < 600; n++) {
        await createNote(test.ctx, "bob", { instance_id: instanceId, remote_id: `n${n}` });
    }
    // carol shares one of his notes.
    await createShare(test.ctx, "carol", reply.id);

    const sender = { domain: "b.example", instanceId, fetched: false };
    const counts = async () => {
        const note = await findNote(test.ctx, hers.id);
        const carol = await test.ctx.db.selectFrom("accounts").select("statuses_count")
            .where("id", "=", "carol").executeTakeFirstOrThrow();
        const left = await test.ctx.db.selectFrom("notes").select("id")
            .where("account_id", "=", "bob").execute();
        return {
            replies: note?.replies_count,
            shares: note?.shares_count,
            carol: carol.statuses_count,
            bob: left.length,
        };
    };

    return { ...test, sender, counts };
};

Deno.test("a deleted user's notes go first, in batches, with what they counted", async () => {
    await using test = await open();
    assertEquals(await test.counts(), { replies: 1, shares: 1, carol: 1, bob: 602 });
    const deleted = registry.types.get("Delete");

    await deleted?.prepare?.(
        test.ctx,
        {
            type: "Delete",
            deleted_type: "User",
            deleted: "bob",
            created_at: "2026-10-25T00:00:00Z",
        },
        test.sender,
        fetchBudget(),
    );

    assertEquals(await test.counts(), { replies: 0, shares: 0, carol: 0, bob: 0 });
    // The user itself goes when the Delete is received.
    const bob = await test.ctx.db.selectFrom("accounts").select("id").where("id", "=", "bob")
        .executeTakeFirst();
    assertEquals(bob?.id, "bob");
});

Deno.test("a Delete of another instance's user removes nothing beforehand", async () => {
    await using test = await open();
    const deleted = registry.types.get("Delete");

    await deleted?.prepare?.(
        test.ctx,
        {
            type: "Delete",
            deleted_type: "User",
            deleted: "c.example:bob",
            created_at: "2026-10-25T00:00:00Z",
        },
        test.sender,
        fetchBudget(),
    );

    assertEquals((await test.counts()).bob, 602);
});
