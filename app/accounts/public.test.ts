import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { decorationsOfAccounts, findAccountByPicture } from "./account_queries.ts";
import { publicAccounts } from "./public.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";

Deno.test("accounts are shown in the order asked, each with its roles once, highest first", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createRole(test.ctx, "Admin", []);
    await createRole(test.ctx, "Mod", []);
    await test.ctx.db.updateTable("roles").set({ visible: true }).execute();
    await test.ctx.db.updateTable("roles").set({ priority: 100 }).where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Mod");
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");

    const shown = await publicAccounts(test.ctx, ["bob", "missing", "alice"]);

    assertEquals(shown.map((account) => account.id), ["bob", "alice"]);
    assertEquals(shown.map((account) => account.roles?.map((role) => role.id)), [
        [],
        ["Admin", "Mod"],
    ]);
    assertEquals(await publicAccounts(test.ctx, []), []);
});

Deno.test("accounts in a list each show their own decorations, in order, once processed", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    const file = async (id: string, processed: boolean) => {
        await test.ctx.db.insertInto("media")
            .values({
                id,
                instance_id: null,
                media_type: "image/png",
                sha256: processed ? id.padEnd(64, "0") : null,
                processed_at: processed ? test.clock.now() : null,
                created_at: test.clock.now(),
            })
            .execute();
    };
    for (const id of ["a0", "a1", "a2", "b0"]) await file(id, true);
    await file("b1", false);
    await test.ctx.db.insertInto("account_decorations")
        .values([
            { account_id: "alice", kind: "avatar_overlay", position: 1, media_id: "a1" },
            { account_id: "alice", kind: "avatar_overlay", position: 0, media_id: "a0" },
            { account_id: "alice", kind: "background", position: 0, media_id: "a2" },
            { account_id: "bob", kind: "avatar_mask", position: 0, media_id: "b0" },
            { account_id: "bob", kind: "background", position: 0, media_id: "b1" },
        ])
        .execute();

    const shown = await publicAccounts(test.ctx, ["bob", "carol", "alice"]);
    const url = (id: string) => `https://social.example/media/${id.padEnd(64, "0")}`;

    assertEquals(shown.map((account) => account.avatar_overlays), [[], [], [url("a0"), url("a1")]]);
    assertEquals(shown.map((account) => account.avatar_mask), [url("b0"), null, null]);
    assertEquals(shown.map((account) => account.background), [null, null, url("a2")]);
    assertEquals(shown.map((account) => account.audio), [null, null, null]);

    const loaded = await decorationsOfAccounts(test.ctx, ["alice", "bob", "carol"]);
    assertEquals(loaded.get("alice")?.map(({ kind, position }) => [kind, position]), [
        ["avatar_overlay", 0],
        ["avatar_overlay", 1],
        ["background", 0],
    ]);
    assertEquals(loaded.get("carol"), undefined);
    assertEquals((await decorationsOfAccounts(test.ctx, [])).size, 0);
});

Deno.test("an account is found through the media of its decoration", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.insertInto("media")
        .values({ id: "m1", instance_id: null, media_type: "audio/ogg", created_at: new Date(0) })
        .execute();
    await test.ctx.db.insertInto("account_decorations")
        .values({ account_id: "alice", kind: "audio", position: 0, media_id: "m1" })
        .execute();

    assertEquals(await findAccountByPicture(test.ctx, "m1"), "alice");
    assertEquals(await findAccountByPicture(test.ctx, "other"), undefined);
});
