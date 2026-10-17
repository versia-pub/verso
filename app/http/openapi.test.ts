import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { Account, CredentialAccount } from "@versia/client-api";
import { z } from "zod";
import { scopes } from "../auth/scopes.ts";
import { openApiDocument } from "./openapi.ts";
import { Binary, defineRoute, Page, Redirect, type Route } from "./route.ts";

const info = { title: "social.example", version: "0.0.0" };
const origin = "https://social.example";
const unused = () => Promise.reject(new Error("Not called"));

Deno.test("a route's inputs are its path, query, header and cookie parameters, and its body", () => {
    const route = defineRoute({
        method: "PATCH",
        path: "/api/v1/things/:id/parts/:part_id",
        summary: "Change a part",
        tags: ["things"],
        params: z.object({ id: z.string(), part_id: z.string() }),
        query: z.object({
            limit: z.coerce.number().int().optional(),
            // Only the client API's entities are named, not schemas named elsewhere.
            sort: z.enum(["new"]).meta({ id: "Sort" }),
        }),
        headers: z.object({ "x-trace": z.string().optional() }),
        cookies: z.object({ session: z.string() }),
        body: z.object({ name: z.string().transform((name) => name.trim()) }),
        responses: { 200: z.object({ ok: z.boolean() }).describe("What happened") },
        handler: unused,
    });

    const body = {
        type: "object" as const,
        properties: { name: { type: "string" as const } },
        required: ["name"],
    };
    const { components: _, ...document } = openApiDocument([route], info, origin);
    assertEquals(document, {
        openapi: "3.1.1",
        info,
        servers: [{ url: origin }],
        paths: {
            "/api/v1/things/{id}/parts/{part_id}": {
                patch: {
                    summary: "Change a part",
                    tags: ["things"],
                    parameters: [
                        { name: "id", in: "path", required: true, schema: { type: "string" } },
                        { name: "part_id", in: "path", required: true, schema: { type: "string" } },
                        {
                            name: "limit",
                            in: "query",
                            required: false,
                            schema: {
                                type: "integer",
                                minimum: Number.MIN_SAFE_INTEGER,
                                maximum: Number.MAX_SAFE_INTEGER,
                            },
                        },
                        {
                            name: "sort",
                            in: "query",
                            required: true,
                            schema: { type: "string", enum: ["new"] },
                        },
                        {
                            name: "x-trace",
                            in: "header",
                            required: false,
                            schema: { type: "string" },
                        },
                        {
                            name: "__Host-session",
                            in: "cookie",
                            required: true,
                            schema: { type: "string" },
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": { schema: body },
                            "application/x-www-form-urlencoded": { schema: body },
                            "multipart/form-data": { schema: body },
                        },
                    },
                    responses: {
                        200: {
                            description: "What happened",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        description: "What happened",
                                        properties: { ok: { type: "boolean" } },
                                        required: ["ok"],
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
});

Deno.test("a route without inputs or tags lists only its summary and responses", () => {
    const routes = [
        defineRoute({
            method: "GET",
            path: "/login",
            summary: "Log in",
            responses: { 200: Page, 302: Redirect, 400: Page },
            handler: unused,
        }),
        defineRoute({
            method: "POST",
            path: "/login",
            summary: "Logged in",
            responses: { 303: Redirect },
            handler: unused,
        }),
        defineRoute({
            method: "GET",
            path: "/accounts/:id/avatar.png",
            summary: "An avatar",
            params: z.object({ id: z.string() }),
            responses: { 200: Binary("image/png") },
            handler: unused,
        }),
        defineRoute({
            method: "GET",
            path: "/.versia/v0.6/instance",
            summary: "For other instances",
            contentType: "application/vnd.versia+json; charset=utf-8",
            responses: { 200: z.object({}) },
            handler: unused,
        }),
    ];

    const page = {
        description: "A page",
        content: { "text/html": { schema: { type: "string" as const } } },
    };
    const redirect = {
        description: "A redirect",
        headers: { location: { required: true as const, schema: { type: "string" as const } } },
    };
    assertEquals(openApiDocument(routes, info, origin).paths, {
        "/login": {
            get: { summary: "Log in", responses: { 200: page, 302: redirect, 400: page } },
            post: { summary: "Logged in", responses: { 303: redirect } },
        },
        "/accounts/{id}/avatar.png": {
            get: {
                summary: "An avatar",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: { 200: { description: "A file", content: { "image/png": {} } } },
            },
        },
        "/.versia/v0.6/instance": {
            get: {
                summary: "For other instances",
                responses: {
                    200: {
                        description: "A JSON body",
                        content: {
                            "application/vnd.versia+json; charset=utf-8": {
                                schema: {
                                    type: "object",
                                    properties: {},
                                },
                            },
                        },
                    },
                },
            },
        },
    });
});

Deno.test("the client API's entities are described once, in components, and referred to", () => {
    const routes = [
        defineRoute({
            method: "GET",
            path: "/accounts",
            summary: "Accounts",
            responses: { 200: z.array(Account), 201: CredentialAccount },
            handler: unused,
        }),
    ];

    const document = openApiDocument(routes, info, origin);
    const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
    const json = (status: number) =>
        document.paths["/accounts"].get.responses[status].content?.["application/json"].schema;
    assertEquals(json(200), { type: "array", items: ref("Account") });
    assertEquals(json(201), ref("CredentialAccount"));

    // Zod gives the account that moved a name of its own in CredentialAccount, which is put back.
    const { schemas } = document.components;
    const moved = { anyOf: [ref("Account"), { type: "null" as const }] };
    assertEquals(schemas.Account.properties?.moved, moved);
    assertEquals(schemas.CredentialAccount.properties?.moved, moved);

    // Exported twice, as ExtendedDescription and as PrivacyPolicy, it is described once.
    assert("ExtendedDescription" in schemas);
    assertFalse("PrivacyPolicy" in schemas);
    assertFalse(/\$defs|__schema/.test(JSON.stringify(document)));
});

Deno.test("a schema that contains itself must be named", () => {
    type Node = { next?: Node };
    const Node: z.ZodType<Node> = z.object({
        get next() {
            return Node.optional();
        },
    });
    const route = (schema: z.ZodType) =>
        defineRoute({
            method: "GET",
            path: "/nodes",
            summary: "Nodes",
            responses: { 200: schema },
            handler: unused,
        });

    for (const schema of [Node, z.object({ node: Node })]) {
        assertThrows(
            () => openApiDocument([route(schema)], info, origin),
            Error,
            "A schema that contains itself must be named",
        );
    }
});

Deno.test("who may call a route is its security, and what OpenAPI can't say is described", () => {
    const route = (path: string, access: Pick<Route, "auth" | "signed">) =>
        defineRoute({
            method: "GET",
            path,
            summary: path,
            ...access,
            responses: { 200: z.object({}) },
            handler: unused,
        });
    const routes = [
        route("/open", {}),
        route("/user", { auth: { require: "user", scope: "read:accounts" } }),
        route("/app", { auth: { require: "app" } }),
        route("/optional", { auth: { require: "optional", scope: "read" } }),
        route("/staff", { auth: { require: "user", permission: "roles" } }),
        route("/federated", { signed: true }),
    ];

    const document = openApiDocument(routes, info, origin);
    const access = (path: string) => {
        const { security, description } = document.paths[path].get;
        return { security, description };
    };
    const user = "Needs a token for a user, not one an app got for itself.";
    assertEquals(access("/open"), { security: undefined, description: undefined });
    assertEquals(access("/user"), {
        security: [{ OAuth2: ["read:accounts"] }],
        description: user,
    });
    assertEquals(access("/app"), { security: [{ OAuth2: [] }], description: undefined });
    assertEquals(access("/optional"), {
        security: [{}, { OAuth2: ["read"] }],
        description: undefined,
    });
    assertEquals(access("/staff"), {
        security: [{ OAuth2: [] }],
        description: `${user} Needs the \`roles\` permission.`,
    });
    assertEquals(access("/federated"), {
        security: [{ VersiaSignature: [] }],
        description: undefined,
    });

    const { OAuth2, VersiaSignature } = document.components.securitySchemes;
    assertEquals(OAuth2.flows.authorizationCode.authorizationUrl, "/oauth/authorize");
    assertEquals(OAuth2.flows.authorizationCode.tokenUrl, "/oauth/token");
    assertEquals(OAuth2.flows.clientCredentials.tokenUrl, "/oauth/token");
    for (const flow of [OAuth2.flows.authorizationCode, OAuth2.flows.clientCredentials]) {
        assertEquals(Object.keys(flow.scopes), [...scopes]);
    }
    assertEquals([VersiaSignature.in, VersiaSignature.name], ["header", "Versia-Signature"]);
});
