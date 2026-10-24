import type { Reference } from "@versia/protocol";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import type { Clock } from "./clock.ts";
import type { FileStore } from "./files.ts";
import type { IdentityProvider } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import type { ImageProcessor } from "./images.ts";
import type { Transport } from "./transport.ts";
import type { UrlBuilder } from "./urls.ts";

/** Other instances' public keys, by domain. */
export type KeyStore = {
    /** The key Verso has for the instance, or else fetches from it, after `beforeFetch`. */
    readonly get: (
        ctx: Context,
        domain: string,
        beforeFetch?: () => Promise<void>,
    ) => Promise<CryptoKey | undefined>;
    /** Fetches the key again, in case the instance rotated it, but only so often. */
    readonly refresh: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
};

/**
 * How many fetches one request or job may make, shared by every resolve it does, so a chain of
 * references can't make it fetch without end.
 */
export type Budget = {
    fetches: number;
    /** When it stops fetching, in milliseconds since the epoch, if ever. */
    readonly until?: number;
    /** How many of its fetched entities are resolving what they refer to now. */
    saving: number;
};

/**
 * Verso's id for the entity of type `type` that `reference` points at, or `undefined` if there is
 * none. A local entity is looked up; a remote one is fetched if Verso doesn't have it, or had it
 * too long ago, unless its instance is blocked, isn't at a domain, or `budget` is spent. If
 * fetching fails, the copy Verso has is used; without one, it throws.
 */
export type Resolver = (
    ctx: Context,
    reference: Reference,
    type: string,
    budget?: Budget,
) => Promise<string | undefined>;

/**
 * What talking to other instances needs: whose keys to sign and check with, whom to ignore, and
 * how to find what they have.
 */
export type Federation = {
    /** This instance's private key. */
    readonly signingKey: (ctx: Context) => Promise<CryptoKey>;
    /** One store for the whole process, so each key is fetched once. */
    readonly remoteKeys: KeyStore;
    /** Whether Verso doesn't federate with an instance, by its domain. */
    readonly isBlocked: (ctx: Context, domain: string) => Promise<boolean>;
    /** One for the whole process, so fetches under way are shared. */
    readonly resolve: Resolver;
};

/**
 * Something that happened, as a service tells the rest of Verso. Plain data, with ids rather than
 * rows, so that any module can read it. Modules' events join this as they arrive.
 */
export type DomainEvent = { readonly type: string };

/**
 * Reacts to events, inside the transaction that emitted them, so what it does commits with the
 * change or not at all. It only writes and enqueues jobs: anything slow, such as fetching from
 * other instances, belongs in a job.
 */
export type Subscriber = (ctx: Context, event: DomainEvent) => Promise<void>;

/** What every service gets as its first argument. Ports join it as they are added. */
export type Context<DB = Database> = {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly urls: UrlBuilder;
    readonly transport: Transport;
    /** Where uploaded files are kept. */
    readonly files: FileStore;
    /** Makes uploaded pictures ready to keep and show. */
    readonly images: ImageProcessor;
    /** One for each configured issuer, by issuer URL. */
    readonly identityProviders: Readonly<Record<string, IdentityProvider>>;
    readonly federation: Federation;
    /** Every subscriber, each told of every event, such as one for each protocol. */
    readonly subscribers: readonly Subscriber[];
    /** The database, or the current transaction inside `transaction`. */
    readonly db: Kysely<DB>;
    /**
     * Runs `work` as one unit: its writes, and the jobs it enqueues, all commit when it resolves,
     * or none do when it throws. Inside a transaction, a nested call joins the outer one rather
     * than starting its own, so one failure undoes the whole unit.
     */
    transaction<T>(work: (tx: Context<DB>) => Promise<T>): Promise<T>;
};

export const createContext = <DB = Database>(
    parts: Omit<Context<DB>, "transaction">,
): Context<DB> => {
    const context: Context<DB> = {
        ...parts,
        transaction: (work) =>
            parts.db.isTransaction
                ? work(context)
                : parts.db.transaction().execute((db) => work(createContext({ ...parts, db }))),
    };

    return context;
};
