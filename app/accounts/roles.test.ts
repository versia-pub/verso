import { assertEquals } from "@std/assert";
import { createTestContext } from "../kernel/testing.ts";
import { accountPermissions } from "./roles.ts";
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
