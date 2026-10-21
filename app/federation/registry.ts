/**
 * Every kind of Versia entity Verso knows, core or from an extension. The federation engine reads
 * each one's descriptor, so adding an entity type means adding a descriptor, and nothing else here.
 * @module
 */
import { type Reference, v0_6 } from "@versia/protocol";
import { z } from "zod";
import { BadSignature, NotFound } from "../http/errors.ts";
import { defineRoute, type Route, versiaJson } from "../http/route.ts";
import type { Budget, Context } from "../kernel/context.ts";

/**
 * Which page of a collection to give: from `offset`, at most `limit` items. Limits from 1 to 40
 * must work, so others are brought within them, and a missing one is the most.
 * @see https://versia.pub/api/endpoints
 */
const CollectionPage = z.object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().optional()
        .transform((limit) => Math.max(1, Math.min(limit ?? 40, 40))),
});
export type CollectionPage = z.output<typeof CollectionPage>;

/**
 * A page of one of a local entity's collections, as `requester` may see it, or `undefined` if
 * there is no such entity here.
 */
export type CollectionProvider = (
    ctx: Context,
    id: string,
    page: CollectionPage,
    requester: string,
) => Promise<v0_6.Collection | v0_6.URICollection | undefined>;

/** An entity Verso has: its id here, and when it was last fetched, or `null` if it is local. */
export type Known = { readonly id: string; readonly fetchedAt: Date | null };

/** The instance an entity came from. */
export type Sender = {
    readonly domain: string;
    /** In `instances`. */
    readonly instanceId: string;
    /** Whether Verso fetched the entity, rather than the instance sending it unasked. */
    readonly fetched: boolean;
};

/**
 * What the federation engine knows of one entity type. Its functions are methods, so a type for
 * one kind of entity fits where any kind is expected.
 */
export type EntityType<T = unknown> = {
    /** Such as `User`, or `pub.versia:likes/Like` for an extension's. */
    readonly type: string;
    /** The extension that defines it, such as `pub.versia:likes`, or none for core types. */
    readonly extension?: string;
    readonly schema: z.ZodType<T>;
    /**
     * The domain of the only instance that may send the entity: its author's, or for one with no
     * author, the one it came from, `origin`. `undefined` if it names none.
     */
    authority(entity: T, origin: string): string | undefined;
    /**
     * Fetches what the entity refers to that Verso may not have, such as its author, before
     * `receive` runs, outside its transaction, so the transaction isn't held open while other
     * instances answer. Fetches count against `budget`. `receive` then only looks them up.
     */
    prepare?(ctx: Context, entity: T, sender: Sender, budget: Budget): Promise<void>;
    /**
     * Applies an entity `sender` sent, in a transaction. It may run more than once for the same
     * entity, so it must be idempotent. It throws `PermanentFailure` for one it can't apply.
     */
    receive(ctx: Context, entity: T, sender: Sender): Promise<void>;
    /**
     * Deletes the entity with this id on `sender`, which a Delete said is gone, if Verso has it.
     * Types without it can't be deleted.
     */
    deleteRemote?(ctx: Context, id: string, sender: Sender): Promise<void>;
    /**
     * The entity `reference` points at, local or remote, if Verso has it. Types without it can't
     * be resolved.
     */
    known?(ctx: Context, reference: Reference): Promise<Known | undefined>;
    /**
     * The local entity with this id as `requester`, another instance, may see it, or `undefined`
     * if there is none or it may not. Types without it can't be fetched.
     */
    readonly find?: (ctx: Context, id: string, requester: string) => Promise<T | undefined>;
    /** Its collections, by name. */
    readonly collections?: Readonly<Record<string, CollectionProvider>>;
};

/** Every entity type, by type name. */
export type Registry = {
    readonly types: ReadonlyMap<string, EntityType>;
    /** The extensions the types come from, for `compatibility.extensions`, sorted. */
    readonly extensions: readonly string[];
};

export const createRegistry = (types: readonly EntityType[]): Registry => {
    const byName = new Map<string, EntityType>();

    for (const type of types) {
        if (byName.has(type.type)) throw new Error(`${type.type} is registered twice`);
        byName.set(type.type, type);
    }

    const extensions = new Set(types.flatMap((type) => type.extension ?? []));

    return { types: byName, extensions: [...extensions].toSorted() };
};

/** The routes another instance fetches one type's entities and their collections at. */
const routesOf = (type: EntityType): Route[] => {
    const { find, collections } = type;
    const path = `/.versia/v0.6/entities/${type.type}/:id`;
    const routes: Route[] = [];

    if (find) {
        routes.push(defineRoute({
            method: "GET",
            path,
            summary: `A local ${type.type}, for another instance`,
            tags: ["versia"],
            signed: true,
            contentType: versiaJson,
            params: z.object({ id: v0_6.Id }),
            responses: { 200: type.schema },
            handler: async (ctx, { params, signedBy }) => {
                // A signed route has refused an unsigned request already.
                if (signedBy === undefined) throw new BadSignature();
                const entity = await find(ctx, params.id, signedBy);
                if (entity === undefined) throw new NotFound();

                return { status: 200, body: entity };
            },
        }));
    }

    if (collections) {
        routes.push(defineRoute({
            method: "GET",
            path: `${path}/collections/:name`,
            summary: `A page of one of a local ${type.type}'s collections, for another instance`,
            tags: ["versia"],
            signed: true,
            contentType: versiaJson,
            params: z.object({ id: v0_6.Id, name: z.string() }),
            query: CollectionPage,
            responses: { 200: z.union([v0_6.Collection, v0_6.URICollection]) },
            handler: async (ctx, { params, query, signedBy }) => {
                const provider = Object.hasOwn(collections, params.name)
                    ? collections[params.name]
                    : undefined;
                if (signedBy === undefined) throw new BadSignature();
                const page = await provider?.(ctx, params.id, query, signedBy);
                if (page === undefined) throw new NotFound();

                return { status: 200, body: page };
            },
        }));
    }

    return routes;
};

/** The routes other instances fetch local entities at, for every type that can be fetched. */
export const entityRoutes = (registry: Registry): readonly Route[] =>
    [...registry.types.values()].flatMap(routesOf);
