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
    // Users may do only what their roles allow, so the tests can tell what each gives.
    const app = createApp(test.ctx, roleRoutes, {
        checkResponses: true,
        permissions: { anonymous: [], default: [] },
    });

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

    const post = async (
        account: string,
        body: string,
        type = "application/json",
        scope: "write:accounts" | "read:accounts" = "write:accounts",
    ) => {
        const response = await app.request("/api/v1/roles", {
            method: "POST",
            body,
            headers: {
                "content-type": type,
                authorization: `Bearer ${await tokenFor(test.ctx, account, [scope])}`,
            },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, get, post };
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

Deno.test("a role manager creates roles below their own, with permissions they have", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");

    const json = await test.post(
        "alice",
        JSON.stringify({
            name: " Mods ",
            permissions: ["roles"],
            priority: 99,
            description: " Keep order ",
            visible: true,
            color: "#00FF00",
            icon: "https://social.example/mods.png",
        }),
    );
    const form = await test.post(
        "alice",
        "name=Helpers&permissions[]=roles&priority=-5&visible=1",
        "application/x-www-form-urlencoded",
    );

    assertEquals(json.status, 201);
    assertEquals({ ...json.body, id: "" }, {
        id: "",
        name: "Mods",
        permissions: ["roles"],
        priority: 99,
        description: "Keep order",
        visible: true,
        icon: "https://social.example/mods.png",
        color: "#00FF00",
    });
    assertEquals(await test.get(`/api/v1/roles/${json.body.id}`), { status: 200, body: json.body });
    assertEquals(
        [form.status, form.body.name, form.body.priority, form.body.visible, form.body.color],
        [201, "Helpers", -5, true, ""],
    );
});

Deno.test("roles at or above the manager's own, or giving more than they have, are refused", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    const refused = (description: string) => ({
        status: 403,
        body: { error: "This action is not allowed", error_description: description },
    });
    const tooHigh = refused("Roles you manage must have a lower priority than your highest role");

    assertEquals(await test.post("alice", '{"name":"Peers","priority":100}'), tooHigh);
    assertEquals(await test.post("alice", '{"name":"Bosses","priority":101}'), tooHigh);
    assertEquals(
        await test.post("alice", '{"name":"Editors","permissions":["owner:account","roles"]}'),
        refused("You can't give permissions you don't have: owner:account"),
    );
    assertEquals((await test.get("/api/v1/roles")).body.length, 2);
});

Deno.test("only role managers create roles, and need a free name", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "bob", "Hidden");

    assertEquals(await test.post("bob", '{"name":"Mine","priority":-1}'), {
        status: 403,
        body: { error: "This action is not allowed" },
    });
    assertEquals(
        (await test.post("alice", '{"name":"Mine"}', "application/json", "read:accounts")).status,
        403,
    );
    assertEquals(await test.post("alice", '{"name":"admin"}'), {
        status: 422,
        body: { error: "Validation failed", details: { name: ["A role with this name exists"] } },
    });

    for (
        const body of [
            "{}",
            '{"name":"  "}',
            '{"name":"A","color":"red"}',
            '{"name":"A","priority":1.5}',
            '{"name":"A","permissions":["fly"]}',
            '{"name":"A","icon":"ftp://social.example/a.png"}',
            `{"name":"${"a".repeat(129)}"}`,
        ]
    ) {
        assertEquals((await test.post("alice", body)).status, 422, body);
    }
});
