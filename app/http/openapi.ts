/**
 * The OpenAPI document, built from the route objects, so it always says what the routes do.
 * @module
 */
import { z } from "zod";
import denoConfig from "../../deno.json" with { type: "json" };
import { scopes } from "../kernel/scopes.ts";
import { defineRoute, type Responses, type Route } from "./route.ts";
import { components, type JsonSchema, jsonSchema, type Naming, naming } from "./openapi_schemas.ts";

/** @see https://spec.openapis.org/oas/v3.1.1.html#parameter-object */
type Parameter = {
    readonly name: string;
    readonly in: "path" | "query" | "header" | "cookie";
    readonly required: boolean;
    /**
     * A property's schema, which JSON Schema lets be `true` for anything or `false` for nothing.
     */
    readonly schema: JsonSchema | boolean;
};

type Content = Readonly<Record<string, { readonly schema?: JsonSchema }>>;

/** @see https://spec.openapis.org/oas/v3.1.1.html#response-object */
type Response = {
    readonly description: string;
    readonly headers?: Readonly<
        Record<
            string,
            { readonly required: boolean; readonly description?: string; schema: JsonSchema }
        >
    >;
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
    readonly externalDocs?: { readonly url: string };
    readonly tags?: readonly string[];
    readonly security?: Security;
    readonly parameters?: readonly Parameter[];
    readonly requestBody?: { readonly required: boolean; readonly content: Content };
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
 * How clients get tokens, and how remote instances sign their requests.
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

/** The media types every body may be sent as, since Mastodon clients send JSON or forms. */
const bodyTypes = ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"];

/** Each key of an object schema, as a parameter in `where` of the request. */
const parameters = (
    where: Parameter["in"],
    schema: z.ZodType | undefined,
    names: Naming,
    name: (key: string) => string = (key) => key,
): Parameter[] => {
    if (!schema) return [];

    const { properties = {}, required = [] } = jsonSchema(schema, names);
    return Object.entries(properties).map(([key, property]) => ({
        name: name(key),
        in: where,
        required: required.includes(key),
        schema: property,
    }));
};

/** The `Link` header of a page of a list. */
const pageLinks: Response["headers"] = {
    link: {
        required: false,
        description: "The older page, as `next`, and the newer one, as `prev`",
        schema: { type: "string" },
    },
};

const response = (
    route: Route,
    declared: NonNullable<Responses[200]>,
    names: Naming,
): Response => {
    if (declared instanceof z.ZodType) {
        const schema = jsonSchema(declared, names);
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
        case "paged":
            return {
                description: "A page of a list, newest first",
                headers: pageLinks,
                content: {
                    "application/json": {
                        schema: { type: "array", items: jsonSchema(declared.item, names) },
                    },
                },
            };
        case "linked":
            return {
                description: "A page of a list",
                headers: pageLinks,
                content: { "application/json": { schema: jsonSchema(declared.body, names) } },
            };
        case "none":
            return { description: "No body" };
    }
};

/** Who may call the route: a remote instance, or a client with a token, and with which scope. */
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

const operation = (route: Route, names: Naming): Operation => {
    const all = [
        ...parameters("path", route.params, names),
        ...parameters("query", route.query, names),
        ...parameters("header", route.headers, names),
        // Verso's cookies are sent with a prefix that the route doesn't see.
        ...parameters("cookie", route.cookies, names, (key) => `__Host-${key}`),
    ];
    const body = route.body && jsonSchema(route.body, names);
    const description = [route.description ?? "", restrictions(route)]
        .filter((part) => part !== "").join("\n\n");
    const needed = security(route);

    return {
        summary: route.summary,
        ...description && { description },
        ...route.docs && { externalDocs: { url: route.docs } },
        ...route.tags && { tags: route.tags },
        ...needed && { security: needed },
        ...all.length > 0 && { parameters: all },
        ...body && {
            requestBody: {
                // A missing body is read as an empty one, which some routes accept.
                required: !route.body?.safeParse(route.textBody ? "" : {}).success,
                content: Object.fromEntries(
                    (route.textBody ? ["text/plain"] : bodyTypes)
                        .map((type) => [type, { schema: body }]),
                ),
            },
        },
        responses: Object.fromEntries(
            Object.entries(route.responses).flatMap(([status, declared]) =>
                declared ? [[status, response(route, declared, names)]] : []
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
    const names = naming();
    const paths: Record<string, Record<string, Operation>> = {};

    for (const route of routes) {
        // Hono's `:id` is OpenAPI's `{id}`.
        const path = route.path.replaceAll(/:(\w+)/g, "{$1}");
        (paths[path] ??= {})[route.method.toLowerCase()] = operation(route, names);
    }

    return {
        openapi: "3.1.1",
        info,
        servers: [{ url: origin }],
        paths,
        components: { schemas: components(names), securitySchemes },
    };
};

/**
 * Serves the document describing `documented`, and this route, titled with the instance's name or
 * else its domain. It is built once, when first requested.
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
                title: name ?? ctx.urls.domain,
                version: denoConfig.version,
            }, ctx.urls.origin);
            return Promise.resolve({ status: 200, body: document });
        },
    });

    return route;
};
