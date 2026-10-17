/**
 * The OpenAPI document, built from the route objects, so it always says what the routes do.
 * @module
 */
import { z } from "zod";
import type { Responses, Route } from "./route.ts";

type JsonSchema = z.core.JSONSchema.JSONSchema;

/** @see https://spec.openapis.org/oas/v3.1.1.html#parameter-object */
type Parameter = {
    readonly name: string;
    readonly in: "path" | "query" | "header" | "cookie";
    readonly required: boolean;
    /** A property's schema, which JSON Schema lets be `true` for anything or `false` for nothing. */
    readonly schema: JsonSchema | boolean;
};

type Content = Readonly<Record<string, { readonly schema?: JsonSchema }>>;

/** @see https://spec.openapis.org/oas/v3.1.1.html#response-object */
type Response = {
    readonly description: string;
    readonly headers?: Readonly<Record<string, { readonly required: true; schema: JsonSchema }>>;
    readonly content?: Content;
};

/** @see https://spec.openapis.org/oas/v3.1.1.html#operation-object */
type Operation = {
    readonly summary: string;
    readonly tags?: readonly string[];
    readonly parameters?: readonly Parameter[];
    readonly requestBody?: { readonly required: true; readonly content: Content };
    readonly responses: Readonly<Record<string, Response>>;
};

/** @see https://spec.openapis.org/oas/v3.1.1.html#openapi-object */
type Document = {
    readonly openapi: "3.1.1";
    readonly info: { readonly title: string; readonly version: string };
    readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
};

/**
 * A schema as JSON Schema, in the shape it is sent: requests before they are parsed, and replies as
 * handlers give them, which are sent without being parsed either.
 */
const jsonSchema = (schema: z.ZodType): JsonSchema => {
    const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" });
    return rest;
};

/** The media types every body may be sent as, since Mastodon clients send JSON or forms. */
const bodyTypes = ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"];

/** Each key of an object schema, as a parameter `where` in the request. */
const parameters = (
    where: Parameter["in"],
    schema: z.ZodType | undefined,
    name: (key: string) => string = (key) => key,
): Parameter[] => {
    if (!schema) return [];

    const { properties = {}, required = [] } = jsonSchema(schema);
    return Object.entries(properties).map(([key, property]) => ({
        name: name(key),
        in: where,
        required: required.includes(key),
        schema: property,
    }));
};

const response = (route: Route, declared: NonNullable<Responses[200]>): Response => {
    if (declared instanceof z.ZodType) {
        const schema = jsonSchema(declared);
        return {
            description: schema.description ?? "A JSON body",
            content: { [route.contentType ?? "application/json"]: { schema } },
        };
    }

    switch (declared.kind) {
        case "page":
            return {
                description: "A page",
                content: { "text/html": { schema: { type: "string" } } },
            };
        case "redirect":
            return {
                description: "A redirect",
                headers: { location: { required: true, schema: { type: "string" } } },
            };
        case "binary":
            return { description: "A file", content: { [declared.type]: {} } };
    }
};

const operation = (route: Route): Operation => {
    const all = [
        ...parameters("path", route.params),
        ...parameters("query", route.query),
        ...parameters("header", route.headers),
        // Verso's cookies are sent with a prefix that the route doesn't see.
        ...parameters("cookie", route.cookies, (key) => `__Host-${key}`),
    ];
    const body = route.body && jsonSchema(route.body);

    return {
        summary: route.summary,
        ...route.tags && { tags: route.tags },
        ...all.length > 0 && { parameters: all },
        ...body && {
            requestBody: {
                required: true,
                content: Object.fromEntries(bodyTypes.map((type) => [type, { schema: body }])),
            },
        },
        responses: Object.fromEntries(
            Object.entries(route.responses).flatMap(([status, declared]) =>
                declared ? [[status, response(route, declared)]] : []
            ),
        ),
    };
};

/**
 * The OpenAPI document describing `routes`.
 * @see https://spec.openapis.org/oas/v3.1.1.html
 */
export const openApiDocument = (
    routes: readonly Route[],
    info: Document["info"],
): Document => {
    const paths: Record<string, Record<string, Operation>> = {};

    for (const route of routes) {
        // Hono's `:id` is OpenAPI's `{id}`.
        const path = route.path.replaceAll(/:(\w+)/g, "{$1}");
        (paths[path] ??= {})[route.method.toLowerCase()] = operation(route);
    }

    return { openapi: "3.1.1", info, paths };
};
