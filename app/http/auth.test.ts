import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { z } from "zod";
import { tokenFor } from "../auth/testing.ts";
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

const open = async () => {
    const test = await createTestContext();
    const http = createApp(test.ctx, [me, app, maybe, anyone], { checkResponses: true });

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

Deno.test("an app's own token is refused where a user is needed, and allowed for apps", async () => {
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
