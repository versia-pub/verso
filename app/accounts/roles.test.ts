import { assertEquals } from "@std/assert";
import type { Issuer } from "../kernel/identity.ts";
import { createTestContext } from "../testing/context.ts";
import { rolesOf } from "./role_queries.ts";
import {
    accountPermissions,
    deleteManagedRole,
    grantRoleTo,
    refusal,
    revokeRoleFrom,
    type RoleManager,
    roleManager,
    syncClaimedRoles,
    updateManagedRole,
    watchRoles,
} from "./roles.ts";
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

    // Both check that the name is free before either takes it.
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

Deno.test("what an account may do is watched through changes to its roles, and to roles themselves", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createRole(test.ctx, "Mod", ["read:note"]);
    await createRole(test.ctx, "Other", []);
    const manager: RoleManager = {
        accountId: "bob",
        highest: Infinity,
        permissions: new Set(["read:note"] as const),
    };
    const issuer: Issuer = {
        name: "ID",
        url: "https://id.example",
        username_claim: "preferred_username",
        registration: "closed",
        roles: [],
    };

    let changes = 0;
    const stop = watchRoles(test.ctx, "alice", () => changes++);
    const counted: number[] = [];
    const count = async (change: Promise<unknown>) => {
        await change;
        counted.push(changes);
    };

    await count(grantRoleTo(test.ctx, "alice", "Mod"));
    // Which she already has.
    await count(grantRoleTo(test.ctx, "alice", "Mod"));
    await count(grantRoleTo(test.ctx, "bob", "Mod"));
    await count(revokeRoleFrom(test.ctx, "alice", "Mod"));
    await count(revokeRoleFrom(test.ctx, "alice", "Mod"));
    await count(updateManagedRole(test.ctx, manager, "Mod", { name: "Moderator" }));
    await count(updateManagedRole(test.ctx, manager, "Mod", { permissions: [] }));
    await count(syncClaimedRoles(test.ctx, issuer, "alice", { sub: "alice" }));
    await count(deleteManagedRole(test.ctx, manager, "Mod"));
    stop();
    await count(grantRoleTo(test.ctx, "alice", "Other"));

    assertEquals(counted, [1, 1, 1, 2, 2, 2, 3, 4, 5, 5]);
});
