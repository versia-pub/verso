import { assertEquals } from "@std/assert";
import { z } from "zod";
import type { Permission } from "../kernel/permissions.ts";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Permissions } from "../kernel/config.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createApp } from "./app.ts";
import { defineRoute } from "./route.ts";

const Answer = z.object({ app: z.string().nullable(), account: z.string().nullable() });

const me = defineRoute({
    method: "GET",
    path: "/me",
    summary: "Needs a user who may read accounts",
    auth: { require: "user", scope: "read:accounts" },
    responses: { 200: Answer },
    handler: (_, { viewer }) =>
        Promise.resolve({ status: 200, body: { app: viewer.appId, account: viewer.accountId } }),
});

const app = defineRoute({
    method: "GET",
    path: "/app",
    summary: "Needs any token",
    auth: { require: "app" },
    responses: { 200: Answer },
    handler: (_, { viewer }) =>
        Promise.resolve({ status: 200, body: { app: viewer.appId, account: viewer.accountId } }),
});

const maybe = defineRoute({
    method: "GET",
    path: "/maybe",
    summary: "Takes a token if there is one",
    auth: { require: "optional" },
    responses: { 200: Answer },
    handler: (_, { viewer }) =>
        Promise.resolve({
            status: 200,
            body: { app: viewer?.appId ?? null, account: viewer?.accountId ?? null },
        }),
});

const anyone = defineRoute({
    method: "GET",
    path: "/anyone",
    summary: "Ignores tokens",
    responses: { 200: Answer },
    handler: (_, { viewer }) =>
        Promise.resolve({ status: 200, body: { app: viewer ?? null, account: null } }),
});

const allowed = (path: string, permission: Permission) =>
    defineRoute({
        method: "GET",
        path,
        summary: "Needs a permission, from anyone",
        auth: { require: "optional", permission },
        responses: { 200: Answer },
        handler: (_, { viewer }) =>
            Promise.resolve({
                status: 200,
                body: { app: viewer?.appId ?? null, account: viewer?.accountId ?? null },
            }),
    });

const Granted = z.object({ first: z.array(z.string()), second: z.array(z.string()) });

/** Reads the viewer's permissions, gives it a role, and reads them again. */
const permissionsRoute = defineRoute({
    method: "GET",
    path: "/permissions",
    summary: "Says what the caller may do",
    auth: { require: "app" },
    responses: { 200: Granted },
    handler: async (ctx, { viewer }) => {
        const first = [...await viewer.permissions()].sort();
        if (viewer.accountId) await giveRole(ctx, viewer.accountId, "Late");
        const second = [...await viewer.permissions()].sort();

        return { status: 200, body: { first, second } };
    },
});

const routes = [
    me,
    app,
    maybe,
    anyone,
    allowed("/roles", "roles"),
    allowed("/read", "read:account"),
    permissionsRoute,
];

const open = async (permissions?: Permissions) => {
    const test = await createTestContext();
    const http = createApp(test.ctx, routes, { checkResponses: true, permissions });

    await createLocalAccount(test.ctx, "alice");

    const call = async (path: string, authorization?: string) => {
        const response = await http.request(path, {
            headers: authorization === undefined ? {} : { authorization },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, call };
};

Deno.test("a user's token reaches a route for users, with the user", async () => {
    await using test = await open();
    const token = await tokenFor(test.ctx, "alice", ["read"]);

    const { status, body } = await test.call("/me", `Bearer ${token}`);

    assertEquals([status, body.account], [200, "alice"]);
});

Deno.test("missing, unknown and non-bearer tokens are refused", async () => {
    await using test = await open();

    for (const authorization of [undefined, "Bearer unknown", "Basic dXNlcjpwYXNz", "Bearer"]) {
        assertEquals(await test.call("/me", authorization), {
            status: 401,
            body: { error: "The access token is invalid" },
        });
    }
});

Deno.test("an app's own token is refused where a user is needed, allowed for apps", async () => {
    await using test = await open();
    const token = `Bearer ${await tokenFor(test.ctx, null, ["read"])}`;

    assertEquals((await test.call("/me", token)).status, 422);
    assertEquals((await test.call("/app", token)).body.account, null);
});

Deno.test("a token without the route's scope is forbidden", async () => {
    await using test = await open();

    for (const scopes of [["write"], ["profile"], ["read:statuses"]] as const) {
        const token = await tokenFor(test.ctx, "alice", [...scopes]);
        assertEquals((await test.call("/me", `Bearer ${token}`)).status, 403);
    }
});

Deno.test("with optional auth, a token sent must still be valid", async () => {
    await using test = await open();
    const token = await tokenFor(test.ctx, "alice");

    assertEquals((await test.call("/maybe")).body.account, null);
    assertEquals((await test.call("/maybe", `Bearer ${token}`)).body.account, "alice");
    assertEquals((await test.call("/maybe", "Bearer unknown")).status, 401);
});

Deno.test("a route without auth ignores tokens", async () => {
    await using test = await open();

    assertEquals(await test.call("/anyone", "Bearer unknown"), {
        status: 200,
        body: { app: null, account: null },
    });
});

Deno.test("a route needing a permission is refused unless a role gives it", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await giveRole(test.ctx, "bob", "Admin");
    const call = async (account: string) =>
        await test.call("/roles", `Bearer ${await tokenFor(test.ctx, account)}`);

    assertEquals(await call("alice"), {
        status: 403,
        body: { error: "This action is not allowed" },
    });
    assertEquals((await call("bob")).status, 200);
});

Deno.test("users get the permissions config gives every user, anyone else the anonymous ones", async () => {
    await using members = await open({ anonymous: [], default: ["read:account"] });
    const user = `Bearer ${await tokenFor(members.ctx, "alice")}`;
    const app = `Bearer ${await tokenFor(members.ctx, null)}`;

    assertEquals((await members.call("/read", user)).status, 200);
    assertEquals((await members.call("/read", app)).status, 403);
    assertEquals((await members.call("/read")).status, 403);

    await using visitors = await open({ anonymous: ["read:account"], default: [] });

    assertEquals((await visitors.call("/read")).status, 200);
    assertEquals(
        (await visitors.call("/read", `Bearer ${await tokenFor(visitors.ctx, "alice")}`)).status,
        403,
    );
});

Deno.test("the viewer's type follows the route's auth", () => {
    defineRoute({
        method: "GET",
        path: "/",
        summary: "Type checks only",
        auth: { require: "optional" },
        responses: { 200: z.string() },
        // @ts-expect-error: there may be no viewer
        handler: (_, { viewer }) => Promise.resolve({ status: 200, body: viewer.appId }),
    });

    defineRoute({
        method: "GET",
        path: "/",
        summary: "Type checks only",
        auth: { require: "app" },
        responses: { 200: z.string() },
        // @ts-expect-error: an app's own token has no account
        handler: (_, { viewer }) => Promise.resolve({ status: 200, body: viewer.accountId }),
    });
});

Deno.test("handlers see what the caller may do, looked up once per request", async () => {
    await using test = await open({ anonymous: ["read:account"], default: ["owner:account"] });
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Late", ["read:account"]);
    await giveRole(test.ctx, "alice", "Admin");

    const user = await test.call("/permissions", `Bearer ${await tokenFor(test.ctx, "alice")}`);
    const app = await test.call("/permissions", `Bearer ${await tokenFor(test.ctx, null)}`);

    const users = ["owner:account", "roles"];
    assertEquals(user.body, { first: users, second: users });
    assertEquals(app.body, { first: ["read:account"], second: ["read:account"] });
});
