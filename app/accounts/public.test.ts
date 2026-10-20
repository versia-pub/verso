import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
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
