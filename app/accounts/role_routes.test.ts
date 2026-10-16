import { assertEquals } from "@std/assert";
import { VersiaRole } from "@versia/client-api";
import { tokenFor } from "../auth/testing.ts";
import { createApp } from "../http/app.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import { roleRoutes } from "./role_routes.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, roleRoutes, { checkResponses: true });

    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Hidden", []);
    await test.ctx.db.updateTable("roles")
        .set({
            priority: 100,
            visible: true,
            color: "#ff3838",
            icon: "https://social.example/admin.png",
        })
        .where("id", "=", "Admin")
        .execute();
    const token = await tokenFor(test.ctx, "bob", ["read:accounts"]);

    const get = async (path: string, authorization = `Bearer ${token}`) => {
        const response = await app.request(path, { headers: { authorization } });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, get };
};

const admin: VersiaRole = {
    id: "Admin",
    name: "Admin",
    permissions: ["roles"],
    priority: 100,
    description: "",
    visible: true,
    icon: "https://social.example/admin.png",
    color: "#ff3838",
};

const hidden: VersiaRole = {
    id: "Hidden",
    name: "Hidden",
    permissions: [],
    priority: 0,
    description: "",
    visible: false,
    color: "",
};

Deno.test("any user may read every role, hidden ones too", async () => {
    await using test = await open();

    assertEquals(await test.get("/api/v1/roles"), { status: 200, body: [admin, hidden] });
    assertEquals(await test.get("/api/v1/roles/Hidden"), { status: 200, body: hidden });
    assertEquals((await test.get("/api/v1/roles/missing")).status, 404);
});

Deno.test("an account's roles are listed once each, highest first", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Hidden");
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");

    assertEquals(await test.get("/api/v1/accounts/alice/roles"), {
        status: 200,
        body: [admin, hidden],
    });
    assertEquals(await test.get("/api/v1/accounts/bob/roles"), { status: 200, body: [] });
});

Deno.test("only local accounts' roles are shown", async () => {
    await using test = await open();
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "remote",
            username: "carol",
            instance_id: await createInstance(test.ctx, "b.example"),
            remote_id: "carol",
            created_at: test.ctx.clock.now(),
        })
        .execute();

    assertEquals((await test.get("/api/v1/accounts/remote/roles")).status, 404);
    assertEquals((await test.get("/api/v1/accounts/missing/roles")).status, 404);
});

Deno.test("roles are read with a user's token that may read accounts", async () => {
    await using test = await open();
    const token = async (account: string | null, scope: "read:accounts" | "read:statuses") =>
        `Bearer ${await tokenFor(test.ctx, account, [scope])}`;

    for (const path of ["/api/v1/roles", "/api/v1/roles/Admin", "/api/v1/accounts/alice/roles"]) {
        assertEquals((await test.get(path, await token("bob", "read:statuses"))).status, 403);
        assertEquals((await test.get(path, await token(null, "read:accounts"))).status, 422);
        assertEquals((await test.get(path, "")).status, 401);
    }
});
