import { assertEquals } from "@std/assert";
import { z } from "zod";
import { openApiDocument } from "./openapi.ts";
import { Binary, defineRoute, Page, Redirect } from "./route.ts";

const info = { title: "social.example", version: "0.0.0" };
const unused = () => Promise.reject(new Error("Not called"));

Deno.test("a route's inputs are its path, query, header and cookie parameters, and its body", () => {
    const route = defineRoute({
        method: "PATCH",
        path: "/api/v1/things/:id/parts/:part_id",
        summary: "Change a part",
        tags: ["things"],
        params: z.object({ id: z.string(), part_id: z.string() }),
        query: z.object({ limit: z.coerce.number().int().optional(), sort: z.enum(["new"]) }),
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
    assertEquals(openApiDocument([route], info), {
        openapi: "3.1.1",
        info,
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
    assertEquals(openApiDocument(routes, info).paths, {
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
