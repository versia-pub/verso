/**
 * Every kind of Versia entity Verso supports, core or from an extension. The federation engine
 * reads each one's descriptor, so adding an entity type means adding a descriptor, and nothing else
 * here.
 * @module
 */
import { type Reference, v0_6 } from "@versia/protocol";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route, versiaJson } from "../http/route.ts";
import type { Budget, Context } from "../kernel/context.ts";

/**
 * Which page of a collection to return: from `offset`, at most `limit` items. Limits from 1 to 40
 * must work, so other values are clamped to that range, and a missing one defaults to the maximum.
 * @see https://versia.pub/api/endpoints
 */
const CollectionPage = z.object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().optional()
        .transform((limit) => Math.max(1, Math.min(limit ?? 40, 40))),
});
export type CollectionPage = z.output<typeof CollectionPage>;

/**
 * A page of one of a local entity's collections, as `requester` may see it, or `undefined` if there
 * is no such local entity.
 */
export type CollectionProvider = (
    ctx: Context,
    id: string,
    page: CollectionPage,
    requester: string,
) => Promise<v0_6.Collection | v0_6.URICollection | undefined>;

/** An entity Verso has: its local id, and when it was last fetched, or `null` if it is local. */
export type Known = { readonly id: string; readonly fetchedAt: Date | null };

/** The instance an entity came from. */
export type Sender = {
    readonly domain: string;
    /** In `instances`. */
    readonly instanceId: string;
    /** Whether Verso fetched the entity, rather than the instance sending it unsolicited. */
    readonly fetched: boolean;
};

/**
 * What the federation engine needs to know about one entity type. Its functions are methods, so a
 * type for one kind of entity fits where any kind is expected.
 */
export type EntityType<T = unknown> = {
    /** Such as `User`, or `pub.versia:likes/Like` for an extension's type. */
    readonly type: string;
    /** The extension that defines it, such as `pub.versia:likes`, or none for core types. */
    readonly extension?: string;
    readonly schema: z.ZodType<T>;
    /**
     * Whether the same entity may be sent again on purpose, such as a user whose profile changed
     * back to what it was. It then counts as already received only when the same signed request is
     * sent again, which is a replay; otherwise whenever the same body is, as a delivery that is
     * tried again is signed again.
     */
    readonly resendable?: boolean;
    /**
     * The domain of the only instance that may send the entity: its author's, or for an entity with
     * no author, the one it came from, `origin`. `undefined` if it names none.
     */
    authority(entity: T, origin: string): string | undefined;
    /**
     * Fetches what the entity refers to that Verso may not have yet, such as its author, before
     * `receive` runs and outside its transaction, so the transaction isn't held open while remote
     * instances respond. Fetches count against `budget`. `receive` then only looks them up.
     */
    prepare?(ctx: Context, entity: T, sender: Sender, budget: Budget): Promise<void>;
    /**
     * Applies an entity sent by `sender`, in a transaction. It may run more than once for the same
     * entity, so it must be idempotent. It throws `PermanentFailure` for an entity it can't apply.
     */
    receive(ctx: Context, entity: T, sender: Sender): Promise<void>;
    /**
     * Deletes the entity with this id on `sender`, which a Delete said is gone, if Verso has it.
     * Types without it can't be deleted.
     */
    deleteRemote?(ctx: Context, id: string, sender: Sender): Promise<void>;
    /**
     * Runs before `deleteRemote`, outside its transaction, for work too large for one transaction,
     * such as removing all of a user's statuses. It may run more than once.
     */
    prepareDelete?(ctx: Context, id: string, sender: Sender): Promise<void>;
    /**
     * The entity `reference` points at, local or remote, if Verso has it. Types without it can't be
     * resolved.
     */
    known?(ctx: Context, reference: Reference): Promise<Known | undefined>;
    /**
     * The local entity with this id, if `requester`, a remote instance, may see it, or `undefined`
     * if there is none or it may not. Types without it can't be fetched.
     */
    readonly find?: (ctx: Context, id: string, requester: string) => Promise<T | undefined>;
    /** Its collections, by name. */
    readonly collections?: Readonly<Record<string, CollectionProvider>>;
};

/** Every entity type, by type name. */
export type Registry = {
    readonly types: ReadonlyMap<string, EntityType>;
    /**
     * The extensions the types come from, plus those that add no types, sorted, for
     * `compatibility.extensions`.
     */
    readonly extensions: readonly string[];
};

/**
 * A registry of `types`. `otherExtensions` are the extensions Verso supports that add no types,
 * such as `pub.versia:custom_emojis`, which adds fields to entities.
 */
export const createRegistry = (
    types: readonly EntityType[],
    otherExtensions: readonly string[] = [],
): Registry => {
    const byName = new Map<string, EntityType>();

    for (const type of types) {
        if (byName.has(type.type)) throw new Error(`${type.type} is registered twice`);
        byName.set(type.type, type);
    }

    const extensions = new Set([
        ...types.flatMap((type) => type.extension ?? []),
        ...otherExtensions,
    ]);

    return { types: byName, extensions: [...extensions].toSorted() };
};

/** The routes where remote instances fetch one type's entities and their collections. */
const routesOf = (type: EntityType): Route[] => {
    const { find, collections } = type;
    // Encoded, as remote instances request it, so an extension's type is one path segment and its
    // `:` isn't mistaken for a parameter. Collection names are encoded too, and arrive decoded.
    const path = `/.versia/v0.6/entities/${encodeURIComponent(type.type)}/:id`;
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
                const page = await provider?.(ctx, params.id, query, signedBy);
                if (page === undefined) throw new NotFound();

                return { status: 200, body: page };
            },
        }));
    }

    return routes;
};

/** The routes where remote instances fetch local entities, for every type that can be fetched. */
export const entityRoutes = (registry: Registry): readonly Route[] =>
    [...registry.types.values()].flatMap(routesOf);
