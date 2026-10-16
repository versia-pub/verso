/**
 * Other instances' public keys, which their signatures are checked with.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { importPublicKey, v0_6 } from "@versia/protocol";
import type { Context } from "../kernel/context.ts";

const logger = getLogger(["verso", "instances"]);

/** Where an instance's keys come from, with the ones already found kept in memory. */
export type RemoteKeys = {
    /** The key of the instance at `domain`: remembered, stored, or else fetched from it. */
    readonly get: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
    /**
     * Fetches the key again, as after a signature fails to verify, in case the instance rotated
     * it. At most once per `refetchAfterMs` for each instance, so bad signatures can't make Verso
     * fetch over and over; within that, the key it has is given.
     */
    readonly refresh: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
};

export type RemoteKeysOptions = {
    /** How many keys to keep in memory. The least recently used are dropped first. */
    readonly capacity?: number;
    readonly refetchAfterMs?: number;
};

/**
 * Fetches the metadata of the instance at `domain`, and returns its public key if the metadata
 * says it is that instance.
 * @see https://versia.pub/api/endpoints
 */
const fetchKey = async (ctx: Context, domain: string): Promise<string | undefined> => {
    try {
        const response = await ctx.transport(
            new Request(`https://${domain}/.versia/v0.6/instance`, {
                headers: { accept: "application/vnd.versia+json" },
            }),
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const metadata = v0_6.InstanceMetadata.parse(await response.json());
        if (metadata.domain !== domain) {
            throw new Error(`The metadata is for ${metadata.domain}`);
        }

        return metadata.public_key.key;
    } catch (error) {
        logger.warn("Couldn't get the key of {domain}: {error}", { domain, error });
        return undefined;
    }
};

/** Keeps the fetched key, as the instance's row, which it creates if there is none yet. */
const storeKey = async (ctx: Context, domain: string, key: string) => {
    const now = ctx.clock.now();

    await ctx.db.insertInto("instances")
        .values({
            id: ctx.ids(),
            domain,
            protocol: "versia",
            public_key: key,
            key_fetched_at: now,
            created_at: now,
        })
        .onConflict((conflict) =>
            conflict.column("domain").doUpdateSet({ public_key: key, key_fetched_at: now })
        )
        .execute();
};

/** A key store for one process, shared by its requests. */
export const remoteKeys = (options: RemoteKeysOptions = {}): RemoteKeys => {
    const capacity = options.capacity ?? 1000;
    const refetchAfterMs = options.refetchAfterMs ?? 5 * 60 * 1000;

    /** Keys by domain, least recently used first. */
    const remembered = new Map<string, CryptoKey>();
    /** Fetches under way, so requests arriving together fetch once. */
    const fetching = new Map<string, Promise<CryptoKey | undefined>>();

    const remember = (domain: string, key: CryptoKey) => {
        remembered.delete(domain);
        remembered.set(domain, key);

        const oldest = remembered.keys().next();
        if (remembered.size > capacity && !oldest.done) remembered.delete(oldest.value);
    };

    const fetchAndStore = (ctx: Context, domain: string) => {
        let pending = fetching.get(domain);
        if (pending) return pending;

        pending = (async () => {
            const spki = await fetchKey(ctx, domain);
            const key = spki === undefined ? undefined : await importPublicKey(spki);
            if (spki === undefined || key === undefined) return undefined;

            await storeKey(ctx, domain, spki);
            remember(domain, key);
            return key;
        })().finally(() => fetching.delete(domain));

        fetching.set(domain, pending);
        return pending;
    };

    const stored = (ctx: Context, domain: string) =>
        ctx.db.selectFrom("instances")
            .select(["public_key", "key_fetched_at"])
            .where("domain", "=", domain)
            .executeTakeFirst();

    return {
        get: async (ctx, domain) => {
            const known = remembered.get(domain);
            if (known) {
                remember(domain, known);
                return known;
            }

            const row = await stored(ctx, domain);
            const key = row?.public_key ? await importPublicKey(row.public_key) : undefined;
            if (!key) return await fetchAndStore(ctx, domain);

            remember(domain, key);
            return key;
        },
        refresh: async (ctx, domain) => {
            const row = await stored(ctx, domain);
            const fetchedAt = row?.key_fetched_at?.getTime() ?? -Infinity;
            const recent = ctx.clock.now().getTime() - fetchedAt < refetchAfterMs;

            // Another node may have stored a newer key than the one remembered here.
            const key = recent && row?.public_key
                ? await importPublicKey(row.public_key)
                : undefined;
            if (!key) return await fetchAndStore(ctx, domain);

            remember(domain, key);
            return key;
        },
    };
};
