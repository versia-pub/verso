import { assertEquals } from "@std/assert";
import { createTestContext } from "../kernel/testing.ts";
import { accountPermissions, rolesOf } from "./roles.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";

Deno.test("an account may do what every user may, and what each of its roles allows", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Profiles", ["owner:account"]);
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");
    await giveRole(test.ctx, "bob", "Profiles");

    const permissions = (id: string) => accountPermissions(test.ctx, id, ["read:account"]);

    assertEquals(await permissions("alice"), new Set(["read:account", "roles"] as const));
    assertEquals(await permissions("bob"), new Set(["read:account", "owner:account"] as const));
});

Deno.test("an account's roles are each listed once, highest priority first", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Mod", []);
    await createRole(test.ctx, "Other", []);
    await test.ctx.db.updateTable("roles").set({ priority: 100 }).where("id", "=", "Mod").execute();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");
    await giveRole(test.ctx, "alice", "Mod");
    await giveRole(test.ctx, "bob", "Other");

    assertEquals((await rolesOf(test.ctx, "alice")).map((role) => role.name), ["Mod", "Admin"]);
});
