/**
 * The OpenAPI document, built from the route objects, so it always says what the routes do.
 * @module
 */
import * as clientApi from "@versia/client-api";
import { z } from "zod";
import denoConfig from "../../deno.json" with { type: "json" };
import { scopes } from "../kernel/scopes.ts";
import { defineRoute, type Responses, type Route } from "./route.ts";

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

/**
 * Each alternative names the schemes a request must satisfy together, with the scopes it needs.
 * @see https://spec.openapis.org/oas/v3.1.1.html#security-requirement-object
 */
type Security = readonly Readonly<Record<string, readonly string[]>>[];

/** @see https://spec.openapis.org/oas/v3.1.1.html#operation-object */
type Operation = {
    readonly summary: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly security?: Security;
    readonly parameters?: readonly Parameter[];
    readonly requestBody?: { readonly required: true; readonly content: Content };
    readonly responses: Readonly<Record<string, Response>>;
};

/** @see https://spec.openapis.org/oas/v3.1.1.html#openapi-object */
type Document = {
    readonly openapi: "3.1.1";
    readonly info: { readonly title: string; readonly version: string };
    readonly servers: readonly { readonly url: string }[];
    readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
    readonly components: {
        readonly schemas: Readonly<Record<string, JsonSchema>>;
        readonly securitySchemes: typeof securitySchemes;
    };
};

/** Every scope, which OpenAPI wants described; Mastodon's names say what they allow. */
const scopeList = Object.fromEntries(scopes.map((scope) => [scope, ""]));

/**
 * How clients get tokens, and how other instances sign their requests.
 * @see https://spec.openapis.org/oas/v3.1.1.html#security-scheme-object
 */
const securitySchemes = {
    OAuth2: {
        type: "oauth2",
        flows: {
            authorizationCode: {
                authorizationUrl: "/oauth/authorize",
                tokenUrl: "/oauth/token",
                scopes: scopeList,
            },
            clientCredentials: { tokenUrl: "/oauth/token", scopes: scopeList },
        },
    },
    VersiaSignature: {
        type: "apiKey",
        in: "header",
        name: "Versia-Signature",
        description: "A Versia signature by another instance, which `Versia-Signed-By` names, " +
            "made at `Versia-Signed-At`. See https://versia.pub/signatures.",
    },
} as const;

/**
 * The client API's entities, named as the package exports them, so the document describes each once,
 * in its components, and refers to it there. A schema that contains itself, as an account contains
 * the one it moved to, can only be described this way.
 */
const entities = new Map<z.ZodType, string>();
for (const [id, schema] of Object.entries(clientApi)) {
    // A schema exported under two names keeps the first.
    if (schema instanceof z.ZodType && !entities.has(schema)) entities.set(schema, id);
}

const named = z.registry<{ id: string }>();
for (const [schema, id] of entities) named.add(schema, { id });
const ids = new Set(entities.values());

/**
 * A schema as JSON Schema, in the shape it is sent: requests before they are parsed, and replies as
 * handlers give them, which are sent without being parsed either. Named schemas are left in `$defs`.
 */
const toJson = (schema: z.ZodType) =>
    z.toJSONSchema(schema, {
        io: "input",
        metadata: named,
        // Descriptions are kept in Zod's own registry, which `metadata` takes the place of.
        override: ({ zodSchema, jsonSchema }) => {
            const { id: _, ...meta } = z.globalRegistry.get(zodSchema) ?? {};
            Object.assign(jsonSchema, meta);
        },
    });

/**
 * The schema in `json`, with references to named schemas pointing into the document's components,
 * and the parts Zod named itself, which repeat within one schema, put back in place. `defs` are the
 * schemas Zod gave alongside.
 */
const resolve = (
    json: string,
    defs: Readonly<Record<string, unknown>>,
    within: readonly string[] = [],
): JsonSchema =>
    JSON.parse(json, (_key, value) => {
        const ref = value?.$ref;
        if (typeof ref !== "string") return value;

        const id = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
        if (id === undefined || within.includes(id)) {
            throw new Error(`A schema that contains itself must be named, at ${ref}`);
        }

        const { $ref: _, ...rest } = value;
        return ids.has(id)
            ? { ...value, $ref: `#/components/schemas/${id}` }
            : { ...rest, ...resolve(JSON.stringify(defs[id]), defs, [...within, id]) };
    });

const jsonSchema = (schema: z.ZodType): JsonSchema => {
    const { $schema: _, $defs = {}, ...rest } = toJson(schema);
    return resolve(JSON.stringify(rest), $defs);
};

/** Every named schema, as the document's components describe it. */
const components = () =>
    Object.fromEntries(
        [...entities].map(([schema, id]) => {
            const { $defs = {} } = toJson(schema);
            return [id, resolve(JSON.stringify($defs[id]), $defs)];
        }),
    );

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

/** Who may call the route: another instance, or a client with a token, and with which scope. */
const security = (route: Route): Security | undefined => {
    if (route.signed) return [{ VersiaSignature: [] }];
    if (!route.auth) return undefined;

    const token = { OAuth2: route.auth.scope ? [route.auth.scope] : [] };
    return route.auth.require === "optional" ? [{}, token] : [token];
};

/** What OpenAPI can't say about who may call the route. */
const restrictions = (route: Route) =>
    [
        route.auth?.require === "user"
            ? "Needs a token for a user, not one an app got for itself."
            : "",
        route.auth?.permission ? `Needs the \`${route.auth.permission}\` permission.` : "",
    ].filter((line) => line !== "").join(" ");

const operation = (route: Route): Operation => {
    const all = [
        ...parameters("path", route.params),
        ...parameters("query", route.query),
        ...parameters("header", route.headers),
        // Verso's cookies are sent with a prefix that the route doesn't see.
        ...parameters("cookie", route.cookies, (key) => `__Host-${key}`),
    ];
    const body = route.body && jsonSchema(route.body);
    const description = restrictions(route);
    const needed = security(route);

    return {
        summary: route.summary,
        ...description && { description },
        ...route.tags && { tags: route.tags },
        ...needed && { security: needed },
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
 * The OpenAPI document describing `routes`, served at `origin`, which example requests are sent to.
 * @see https://spec.openapis.org/oas/v3.1.1.html
 */
export const openApiDocument = (
    routes: readonly Route[],
    info: Document["info"],
    origin: string,
): Document => {
    const paths: Record<string, Record<string, Operation>> = {};

    for (const route of routes) {
        // Hono's `:id` is OpenAPI's `{id}`.
        const path = route.path.replaceAll(/:(\w+)/g, "{$1}");
        (paths[path] ??= {})[route.method.toLowerCase()] = operation(route);
    }

    return {
        openapi: "3.1.1",
        info,
        servers: [{ url: origin }],
        paths,
        components: { schemas: components(), securitySchemes },
    };
};

/**
 * Serves the document describing `documented`, and this route, titled with the instance's name or
 * else its domain. It is built once, when first asked for.
 */
export const openApiRoute = (documented: readonly Route[], name: string | undefined): Route => {
    let document: Document | undefined;

    const route = defineRoute({
        method: "GET",
        path: "/openapi.json",
        summary: "This API, described with OpenAPI",
        tags: ["docs"],
        responses: { 200: z.looseObject({ openapi: z.literal("3.1.1") }) },
        handler: (ctx) => {
            document ??= openApiDocument([...documented, route], {
                title: name ?? new URL(ctx.urls.origin).hostname,
                version: denoConfig.version,
            }, ctx.urls.origin);
            return Promise.resolve({ status: 200, body: document });
        },
    });

    return route;
};
