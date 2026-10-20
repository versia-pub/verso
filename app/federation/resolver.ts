/**
 * Resolving references to entities: the ones Verso has, or else fetched from the instance that
 * hosts them.
 * @see https://versia.pub/federation/http
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { canonicalizeDomain, type Reference } from "@versia/protocol";
import { z } from "zod";
import { HttpError } from "../http/errors.ts";
import { findInstanceId } from "../instances/instances.ts";
import type { Budget, Context, Resolver } from "../kernel/context.ts";
import { lru } from "../kernel/lru.ts";
import { entityUrl } from "../kernel/urls.ts";
import { checkEntity } from "./inbox.ts";
import type { EntityType, Registry } from "./registry.ts";
import { BadReply, fetchSigned, Unreachable } from "./request.ts";

const logger = getLogger(["verso", "federation"]);

export const fetchBudget = (fetches = 20): Budget => ({ fetches });

/** An entity that couldn't be fetched, or wasn't what was asked for. */
export class ResolveFailed extends Error {
    override readonly name = "ResolveFailed";
}

/**
 * Whether `error` is another instance failing Verso: unreachable, too slow, or answering with
 * something Verso can't use.
 */
export const isRemoteFailure = (error: unknown): boolean =>
    error instanceof ResolveFailed ||
    error instanceof BadReply ||
    error instanceof Unreachable;

export type ResolverOptions = {
    /** How long a fetched entity is used before it is fetched again. Defaults to a day. */
    readonly maxAgeMs?: number;
    /** How long an entity its instance says is gone counts as missing. Defaults to an hour. */
    readonly missingMs?: number;
    /** How many missing entities to remember. */
    readonly capacity?: number;
};

const Identified = z.object({ id: z.string() });

/** A resolver for the types in `registry`. Make one for each process, and share it. */
export const createResolver = (registry: Registry, options: ResolverOptions = {}): Resolver => {
    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
    const missingMs = options.missingMs ?? 60 * 60_000;

    /** When each missing entity may be fetched again. */
    const missing = lru<string, number>(options.capacity ?? 10_000);
    /** Fetches under way, so resolves arriving together fetch once. */
    const fetching = new Map<string, Promise<string | undefined>>();

    /** Fetches the entity and saves it, giving its id, or `undefined` if it is gone. */
    const fetchEntity = async (
        ctx: Context,
        type: EntityType,
        reference: Reference,
        key: string,
        budget: Budget,
    ) => {
        const { host, id } = reference;
        const reply = await fetchSigned(ctx, entityUrl(host, type.type, id));

        if (reply.status === 404 || reply.status === 410) {
            missing.set(key, ctx.clock.now().getTime() + missingMs);
            return undefined;
        }
        if (reply.status < 200 || reply.status > 299) {
            throw new ResolveFailed(`${host} answered ${reply.status} for ${type.type} ${id}`);
        }

        let checked;
        try {
            checked = checkEntity(registry, reply.body);
        } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            throw new ResolveFailed(`${host} sent an invalid ${type.type}: ${error.message}`);
        }

        // An instance asked for one entity mustn't be able to answer with another, and so
        // overwrite it.
        const entityId = Identified.safeParse(checked?.entity).data?.id;
        if (checked?.type !== type || entityId !== id) {
            throw new ResolveFailed(`${host} didn't send the ${type.type} ${id} it was asked for`);
        }
        const { entity } = checked;
        if (type.authority(entity, host) !== host) {
            throw new ResolveFailed(`${host} may not send the ${type.type} ${id}`);
        }

        // Its row was made when its key was fetched, to check the reply's signature.
        const instanceId = await findInstanceId(ctx, host);
        if (instanceId === undefined) throw new ResolveFailed(`${host} isn't a known instance`);

        const sender = { domain: host, instanceId, fetched: true };
        await type.prepare?.(ctx, entity, sender, budget);
        await ctx.transaction((tx) => type.receive(tx, entity, sender));
        return (await type.known?.(ctx, reference))?.id;
    };

    return async (ctx, reference, typeName, budget = fetchBudget()) => {
        const type = registry.types.get(typeName);
        if (!type?.known) throw new Error(`A ${typeName} can't be resolved`);

        const known = await type.known(ctx, reference);
        if (reference.host === ctx.urls.domain) return known?.id;

        const now = ctx.clock.now().getTime();
        if (known?.fetchedAt && now - known.fetchedAt.getTime() < maxAgeMs) return known.id;

        // Blocks go by domain, so a host with a port, or an address, could get around them.
        if (canonicalizeDomain(reference.host) !== reference.host) return undefined;
        if (await ctx.federation.isBlocked(ctx, reference.host)) return undefined;

        const key = `${type.type} ${reference.host} ${reference.id}`;
        if ((missing.get(key) ?? 0) > now) return undefined;

        let pending = fetching.get(key);
        if (!pending) {
            if (budget.fetches <= 0) return known?.id;
            budget.fetches--;

            pending = fetchEntity(ctx, type, reference, key, budget).finally(() =>
                fetching.delete(key)
            );
            fetching.set(key, pending);
        }

        try {
            return await pending;
        } catch (error) {
            if (!known) throw error;

            logger.warn("Using the {type} {id} Verso has, since fetching it failed: {error}", {
                type: type.type,
                id: known.id,
                error,
            });
            return known.id;
        }
    };
};
