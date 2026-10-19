import { assertEquals } from "@std/assert";
import { createTestContext } from "../testing/context.ts";
import { rolesOf } from "./role_queries.ts";
import { accountPermissions, refusal, roleManager, updateManagedRole } from "./roles.ts";
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

Deno.test("two roles renamed to one name at once get it once", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    for (const name of ["Admin", "Red", "Blue"]) await createRole(test.ctx, name, []);
    await test.ctx.db.updateTable("roles").set({ priority: 10 }).where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Admin");
    const alice = await roleManager(test.ctx, "alice", new Set());

    // Both check the name is free before either takes it.
    const renamed = await Promise.all(
        ["Red", "Blue"].map((id) => updateManagedRole(test.ctx, alice, id, { name: "Purple" })),
    );

    assertEquals(renamed.map((result) => result.ok).toSorted(), [false, true]);
});

Deno.test("an account manages only roles below its highest, giving permissions it has", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Mod", []);
    await test.ctx.db.updateTable("roles").set({ priority: 10 }).where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Mod");
    await giveRole(test.ctx, "alice", "Admin");

    const alice = await roleManager(test.ctx, "alice", new Set(["roles"] as const));
    const bob = await roleManager(test.ctx, "bob", new Set(["roles"] as const));

    assertEquals(refusal(alice, { priority: 9, permissions: ["roles"] }), undefined);
    assertEquals(refusal(alice, {}), undefined);
    assertEquals(
        refusal(alice, { priority: 10 }),
        "Roles you manage must have a lower priority than your highest role",
    );
    assertEquals(
        refusal(bob, { priority: -1000 }),
        "Roles you manage must have a lower priority than your highest role",
    );
});
