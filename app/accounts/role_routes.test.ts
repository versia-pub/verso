import { assertEquals } from "@std/assert";
import { VersiaRole } from "@versia/client-api";
import { tokenFor } from "../auth/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { roleRoutes } from "./role_routes.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";

const open = async () => {
    const test = await createTestContext();
    // Users may do only what their roles allow, so the tests can tell what each role grants.
    const app = createTestApp(test.ctx, roleRoutes, {
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

    const send = async (
        method: "POST" | "PATCH" | "DELETE",
        path: string,
        account: string,
        body?: string,
        type = "application/json",
        scope: "write:accounts" | "read:accounts" = "write:accounts",
    ) => {
        const response = await app.request(path, {
            method,
            body,
            headers: {
                "content-type": type,
                authorization: `Bearer ${await tokenFor(test.ctx, account, [scope])}`,
            },
        });
        return { status: response.status, body: await response.json() };
    };

    const post = (account: string, body: string, type?: string, scope?: "read:accounts") =>
        send("POST", "/api/v1/roles", account, body, type, scope);

    return { ...test, get, send, post };
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

const tooHigh = {
    status: 403,
    body: {
        error: "This action is not allowed",
        error_description: "Roles you manage must have a lower priority than your highest role",
    },
};

Deno.test("a role manager changes roles below their own, keeping what they lack", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await test.ctx.db.updateTable("roles").set({ permissions: ["owner:account"] })
        .where("id", "=", "Hidden").execute();

    const json = await test.send(
        "PATCH",
        "/api/v1/roles/Hidden",
        "alice",
        JSON.stringify({
            name: " Helpers ",
            permissions: ["roles", "owner:account", "roles"],
            priority: 99,
            description: " Help out ",
            visible: true,
            color: "#00ff00",
            icon: "https://social.example/helpers.png",
        }),
    );
    const helpers = {
        id: "Hidden",
        name: "Helpers",
        permissions: ["roles", "owner:account"],
        priority: 99,
        description: "Help out",
        visible: true,
        icon: "https://social.example/helpers.png",
        color: "#00ff00",
    };

    assertEquals(json, { status: 200, body: helpers });
    assertEquals(await test.get("/api/v1/roles/Hidden"), json);
    assertEquals(await test.send("PATCH", "/api/v1/roles/Hidden", "alice", "{}"), json);
    assertEquals(
        await test.send(
            "PATCH",
            "/api/v1/roles/Hidden",
            "alice",
            "name=HELPERS&priority=-5",
            "application/x-www-form-urlencoded",
        ),
        { status: 200, body: { ...helpers, name: "HELPERS", priority: -5 } },
    );

    const { icon: _, ...withoutIcon } = helpers;
    assertEquals(
        await test.send("PATCH", "/api/v1/roles/Hidden", "alice", '{"icon":null}'),
        { status: 200, body: { ...withoutIcon, name: "HELPERS", priority: -5 } },
    );
});

Deno.test("changes to roles at or above the manager's own, or giving more, are refused", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "bob", "Hidden");
    const patch = (body: string, id = "Hidden", account = "alice") =>
        test.send("PATCH", `/api/v1/roles/${id}`, account, body);

    assertEquals(await patch('{"description":"Mine"}', "Admin"), tooHigh);
    assertEquals(await patch('{"priority":100}'), tooHigh);
    assertEquals(await patch('{"permissions":["roles","owner:account"]}'), {
        status: 403,
        body: {
            error: "This action is not allowed",
            error_description: "You can't give permissions you don't have: owner:account",
        },
    });
    assertEquals(await patch('{"name":"admin"}'), {
        status: 422,
        body: { error: "Validation failed", details: { name: ["A role with this name exists"] } },
    });
    assertEquals((await patch('{"priority":-1}', "missing")).status, 404);
    assertEquals(await patch('{"priority":-1}', "Hidden", "bob"), {
        status: 403,
        body: { error: "This action is not allowed" },
    });
    assertEquals(
        (await test.send(
            "PATCH",
            "/api/v1/roles/Hidden",
            "alice",
            '{"priority":-1}',
            "application/json",
            "read:accounts",
        )).status,
        403,
    );
    assertEquals((await patch('{"priority":1.5}')).status, 422);
    assertEquals(await test.get("/api/v1/roles"), { status: 200, body: [admin, hidden] });
});

Deno.test("a role manager deletes roles below their own, taking them from everyone", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "bob", "Hidden");
    await giveRole(test.ctx, "bob", "Hidden", "https://id.example");
    const remove = (id: string, account = "alice") =>
        test.send("DELETE", `/api/v1/roles/${id}`, account);

    assertEquals(await remove("Admin"), tooHigh);
    assertEquals(await remove("Hidden", "bob"), {
        status: 403,
        body: { error: "This action is not allowed" },
    });
    assertEquals(await remove("Hidden"), { status: 200, body: {} });
    assertEquals(await remove("Hidden"), {
        status: 404,
        body: { error: "Record not found" },
    });

    assertEquals(await test.get("/api/v1/roles"), { status: 200, body: [admin] });
    assertEquals(await test.get("/api/v1/accounts/bob/roles"), { status: 200, body: [] });
    assertEquals(await test.get("/api/v1/accounts/alice/roles"), { status: 200, body: [admin] });
});

/** Who has which role, and from whom. */
const assignments = async (ctx: Context) =>
    (await ctx.db.selectFrom("account_roles").select(["account_id", "role_id", "issuer"]).execute())
        .map((row) => `${row.account_id}: ${row.role_id} from ${row.issuer ?? "an admin"}`)
        .sort();

Deno.test("a role manager gives and takes away roles below their own, as an admin", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "bob", "Hidden", "https://id.example");
    const send = (method: "POST" | "DELETE") =>
        test.send(method, "/api/v1/accounts/bob/roles/Hidden", "alice");

    assertEquals(await send("POST"), { status: 200, body: {} });
    assertEquals(await send("POST"), { status: 200, body: {} });
    assertEquals(await assignments(test.ctx), [
        "alice: Admin from an admin",
        "bob: Hidden from an admin",
        "bob: Hidden from https://id.example",
    ]);

    assertEquals(await send("DELETE"), { status: 200, body: {} });
    assertEquals(await send("DELETE"), { status: 200, body: {} });
    assertEquals(await assignments(test.ctx), [
        "alice: Admin from an admin",
        "bob: Hidden from https://id.example",
    ]);
});

Deno.test("roles at or above the manager's own, or with more than they have, aren't given", async () => {
    await using test = await open();
    await giveRole(test.ctx, "alice", "Admin");
    await createRole(test.ctx, "Owners", ["owner:account"]);
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "remote",
            username: "carol",
            instance_id: await createInstance(test.ctx, "b.example"),
            remote_id: "carol",
            created_at: test.ctx.clock.now(),
        })
        .execute();
    const before = await assignments(test.ctx);

    for (const method of ["POST", "DELETE"] as const) {
        const send = (path: string, account = "alice", scope?: "read:accounts") =>
            test.send(method, `/api/v1/accounts/${path}`, account, undefined, undefined, scope);

        assertEquals(await send("bob/roles/Admin"), tooHigh, method);
        assertEquals(await send("alice/roles/Admin"), tooHigh, method);
        assertEquals((await send("missing/roles/Hidden")).status, 404, method);
        assertEquals((await send("remote/roles/Hidden")).status, 404, method);
        assertEquals((await send("bob/roles/missing")).status, 404, method);
        assertEquals(await send("alice/roles/Hidden", "bob"), {
            status: 403,
            body: { error: "This action is not allowed" },
        });
        assertEquals((await send("bob/roles/Hidden", "alice", "read:accounts")).status, 403);
    }

    assertEquals(await test.send("POST", "/api/v1/accounts/alice/roles/Owners", "alice"), {
        status: 403,
        body: {
            error: "This action is not allowed",
            error_description: "You can't give permissions you don't have: owner:account",
        },
    });
    assertEquals(await assignments(test.ctx), before);
});

Deno.test("a role manager changes only the roles of accounts below them, or their own", async () => {
    await using test = await open();
    await createRole(test.ctx, "Moderator", ["roles"]);
    await test.ctx.db.updateTable("roles").set({ priority: 50 }).where("id", "=", "Moderator")
        .execute();
    await createLocalAccount(test.ctx, "carol");
    await createLocalAccount(test.ctx, "dave");
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "bob", "Moderator");
    await giveRole(test.ctx, "carol", "Moderator");
    const send = (method: "POST" | "DELETE", account: string) =>
        test.send(method, `/api/v1/accounts/${account}/roles/Hidden`, "bob");
    const outranked = {
        status: 403,
        body: {
            error: "This action is not allowed",
            error_description: "You can only change the roles of accounts below your highest role",
        },
    };

    for (const method of ["POST", "DELETE"] as const) {
        assertEquals(await send(method, "alice"), outranked, `${method} alice`);
        assertEquals(await send(method, "carol"), outranked, `${method} carol`);
    }
    for (const account of ["dave", "bob"]) {
        assertEquals(await send("POST", account), { status: 200, body: {} }, account);
    }
    assertEquals(await assignments(test.ctx), [
        "alice: Admin from an admin",
        "bob: Hidden from an admin",
        "bob: Moderator from an admin",
        "carol: Moderator from an admin",
        "dave: Hidden from an admin",
    ]);

    for (const account of ["dave", "bob"]) {
        assertEquals(await send("DELETE", account), { status: 200, body: {} }, account);
    }
});
