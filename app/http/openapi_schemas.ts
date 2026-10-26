/**
 * Zod schemas as JSON Schemas, for the OpenAPI document, with the ones Verso names kept apart as
 * its components, and referred to by name.
 * @module
 */
import * as clientApi from "@versia/client-api";
import { z } from "zod";

export type JsonSchema = z.core.JSONSchema.JSONSchema;

/**
 * The client API's entities, named as the package exports them, so the document describes each
 * once, in its components, and refers to it there. A schema that contains itself, as an account
 * contains the one it moved to, can only be described this way.
 */
export const naming = (): Naming => {
    const entities = new Map<z.ZodType, string>();
    for (const [id, schema] of Object.entries(clientApi)) {
        // A schema exported under two names keeps the first.
        if (schema instanceof z.ZodType && !entities.has(schema)) entities.set(schema, id);
    }

    const registry = z.registry<{ id: string }>();
    for (const [schema, id] of entities) registry.add(schema, { id });

    return { entities, registry, ids: new Set(entities.values()) };
};

/** The schemas Verso names, and what it names them. */
export type Naming = {
    readonly entities: Map<z.ZodType, string>;
    readonly registry: z.core.$ZodRegistry<{ id: string }>;
    readonly ids: Set<string>;
};

/**
 * A schema as JSON Schema, in the shape it is sent: requests before they are parsed, and replies as
 * handlers give them, which are sent without being parsed either. Named schemas are left in
 * `$defs`.
 */
const toJson = (schema: z.ZodType, names: Naming) =>
    z.toJSONSchema(schema, {
        io: "input",
        metadata: names.registry,
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
    names: Naming,
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
        return names.ids.has(id)
            ? { ...value, $ref: `#/components/schemas/${id}` }
            : { ...rest, ...resolve(JSON.stringify(defs[id]), defs, names, [...within, id]) };
    });

export const jsonSchema = (schema: z.ZodType, names: Naming): JsonSchema => {
    const { $schema: _, $defs = {}, ...rest } = toJson(schema, names);
    return resolve(JSON.stringify(rest), $defs, names);
};

/** Every named schema, as the document's components describe it. */
export const components = (names: Naming): Record<string, JsonSchema> =>
    Object.fromEntries(
        [...names.entities].map(([schema, id]) => {
            const { $defs = {} } = toJson(schema, names);
            return [id, resolve(JSON.stringify($defs[id]), $defs, names)];
        }),
    );
