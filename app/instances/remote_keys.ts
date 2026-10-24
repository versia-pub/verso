/**
 * Other instances' public keys, which their signatures are checked with.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { canonicalizeDomain, importPublicKey, v0_6 } from "@versia/protocol";
import { messagingExtension } from "../federation/messaging.ts";
import { fetchUnsigned } from "../federation/request.ts";
import { versiaJson } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { lru } from "../kernel/lru.ts";
import { versiaUrl } from "../kernel/urls.ts";

const logger = getLogger(["verso", "instances"]);

/** Where an instance's keys come from, with the ones already found kept in memory. */
export type RemoteKeys = {
    /**
     * The key of the instance at `domain`: remembered, stored, or else fetched from it, once
     * `beforeFetch` has run, as a rate limit that may refuse the fetch.
     */
    readonly get: (
        ctx: Context,
        domain: string,
        beforeFetch?: () => Promise<void>,
    ) => Promise<CryptoKey | undefined>;
    /**
     * Fetches the key again, as after a signature fails to verify, in case the instance rotated
     * it. At most once per `refetchAfterMs` for each instance, so bad signatures can't make Verso
     * fetch over and over; within that, the key it has is given.
     *
     * Either way, an instance whose key couldn't be had isn't asked again for `refetchAfterMs`, so
     * requests naming it can't make Verso send a request each.
     */
    readonly refresh: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
};

export type RemoteKeysOptions = {
    /** How many keys to keep in memory. The least recently used are dropped first. */
    readonly capacity?: number;
    readonly refetchAfterMs?: number;
    /** How many keys may be fetched at once, so unknown signers can't tie up Verso's requests. */
    readonly concurrency?: number;
};

/** What Verso keeps of an instance's metadata. */
type Metadata = {
    /** SPKI, in base64. */
    readonly key: string;
    readonly takesMessages: boolean;
};

/**
 * Fetches the metadata of the instance at `domain`, and returns its public key, and whether it
 * takes instance messages, if the metadata says it is that instance.
 * @see https://versia.pub/api/endpoints
 */
const fetchMetadata = async (ctx: Context, domain: string): Promise<Metadata | undefined> => {
    try {
        const reply = await fetchUnsigned(ctx, versiaUrl(domain, "/instance"), versiaJson);
        if (reply.status < 200 || reply.status > 299) throw new Error(`HTTP ${reply.status}`);

        const metadata = v0_6.InstanceMetadata.parse(
            JSON.parse(new TextDecoder().decode(reply.body)),
        );
        if (canonicalizeDomain(metadata.domain) !== domain) {
            throw new Error(`The metadata is for ${metadata.domain}`);
        }

        return {
            key: metadata.public_key.key,
            takesMessages: metadata.compatibility.extensions.includes(messagingExtension),
        };
    } catch (error) {
        logger.warn("Couldn't get the key of {domain}: {error}", { domain, error });
        return undefined;
    }
};

/** Keeps the fetched metadata, in the instance's row, which it creates if there is none yet. */
const storeMetadata = async (ctx: Context, domain: string, metadata: Metadata) => {
    const now = ctx.clock.now();
    const kept = {
        public_key: metadata.key,
        key_fetched_at: now,
        takes_messages: metadata.takesMessages,
    };

    await ctx.db.insertInto("instances")
        .values({
            id: ctx.ids(),
            domain,
            protocol: "versia",
            ...kept,
            created_at: now,
        })
        .onConflict((conflict) => conflict.column("domain").doUpdateSet(kept))
        .execute();
};

/** A key store for one process, shared by its requests. */
export const remoteKeys = (options: RemoteKeysOptions = {}): RemoteKeys => {
    const capacity = options.capacity ?? 1000;
    const refetchAfterMs = options.refetchAfterMs ?? 5 * 60 * 1000;
    const concurrency = options.concurrency ?? 16;

    /** Keys by domain, least recently used first. */
    const remembered = new Map<string, CryptoKey>();
    /** Fetches under way, so requests arriving together fetch once. */
    const fetching = new Map<string, Promise<CryptoKey | undefined>>();
    /** When each instance whose key couldn't be had may be asked again. */
    const failed = lru<string, number>(capacity);

    const remember = (domain: string, key: CryptoKey) => {
        remembered.delete(domain);
        remembered.set(domain, key);

        const oldest = remembered.keys().next();
        if (remembered.size > capacity && !oldest.done) remembered.delete(oldest.value);
    };

    const fetchAndStore = (ctx: Context, domain: string) => {
        let pending = fetching.get(domain);
        if (pending) return pending;

        const now = ctx.clock.now().getTime();
        if ((failed.get(domain) ?? 0) > now) return Promise.resolve(undefined);
        if (fetching.size >= concurrency) return Promise.resolve(undefined);

        pending = (async () => {
            const metadata = await fetchMetadata(ctx, domain);
            const key = metadata === undefined ? undefined : await importPublicKey(metadata.key);
            if (metadata === undefined || key === undefined) {
                failed.set(domain, now + refetchAfterMs);
                return undefined;
            }

            await storeMetadata(ctx, domain, metadata);
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
        get: async (ctx, domain, beforeFetch) => {
            const known = remembered.get(domain);
            if (known) {
                remember(domain, known);
                return known;
            }

            const row = await stored(ctx, domain);
            const key = row?.public_key ? await importPublicKey(row.public_key) : undefined;
            if (!key) {
                await beforeFetch?.();
                // A fetch may have finished while this looked, and it is remembered before it ends.
                return remembered.get(domain) ?? await fetchAndStore(ctx, domain);
            }

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
