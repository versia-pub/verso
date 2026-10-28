import { getLogger } from "@logtape/logtape";
import type { Reference } from "@versia/protocol";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import type { Clock } from "./clock.ts";
import type { Settings } from "./settings.ts";
import type { FileStore } from "./files.ts";
import type { IdentityProvider } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import type { ImageProcessor } from "./images.ts";
import type { Transport } from "./transport.ts";
import type { UrlBuilder } from "./urls.ts";

/** Remote instances' public keys, by domain. */
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
 * fetching fails, the stored copy is used; without one, it throws.
 */
export type Resolver = (
    ctx: Context,
    reference: Reference,
    type: string,
    budget?: Budget,
) => Promise<string | undefined>;

/**
 * What talking to remote instances and push services needs: whose keys to sign and validate with,
 * whom to ignore, and how to find what they have.
 */
export type Federation = {
    /** This instance's current key pair, cached for a minute at most. */
    readonly instanceKey: (ctx: Context) => Promise<InstanceKey>;
    /** This instance's key pair for Web Push, which never changes, cached for a minute at most. */
    readonly vapidKey: (ctx: Context) => Promise<VapidKey>;
    /** One store for the whole process, so each key is fetched once. */
    readonly remoteKeys: KeyStore;
    /**
     * Whether Verso doesn't federate with an instance, by its domain. The blocks are cached for a
     * minute at most, or until a process that changes them says so.
     */
    readonly isBlocked: (ctx: Context, domain: string) => Promise<boolean>;
    /** One for the whole process, so fetches in progress are shared. */
    readonly resolve: Resolver;
    /** Clears the cached instance key and blocks, such as after a process changed them. */
    readonly forget: () => void;
};

/** A key to sign as this instance with, and its public half as InstanceMetadata shows it. */
export type InstanceKey = {
    readonly privateKey: CryptoKey;
    /** SPKI, in base64. */
    readonly publicKey: string;
};

/** A key to sign Web Push requests with, and its public half as an uncompressed point. */
export type VapidKey = {
    readonly privateKey: CryptoKey;
    readonly publicKey: Uint8Array<ArrayBuffer>;
};

/**
 * Something that happened, as a service tells the rest of Verso. Plain data, with ids rather than
 * rows, so that any module can read it. Modules' events join this as they arrive.
 */
export type DomainEvent = { readonly type: string };

/**
 * Reacts to events, inside the transaction that emitted them, so what it does commits with the
 * change or not at all. It only writes and enqueues jobs: anything slow, such as fetching from
 * remote instances, belongs in a job.
 */
export type Subscriber = (ctx: Context, event: DomainEvent) => Promise<void>;

/** Hears what is sent on one channel. */
export type Handler = (payload: string) => Promise<void>;

/**
 * Sends messages to every process, and hears them. Use `publish` and `subscribe`, which send once
 * the transaction commits, and check what is heard.
 */
export type PubSub = {
    /**
     * Sends `payload`, a message as JSON, to the subscribers of `channel`. It may be at most
     * 7,000 bytes, so that it fits in a Postgres notification, of 8,000, with the channel's name.
     */
    readonly send: (channel: string, payload: string) => Promise<void>;
    /**
     * Gives `handler` what is sent on `channel` from now on, until the function returned is called.
     * Subscribing a handler that is already subscribed does nothing.
     */
    readonly subscribe: (channel: string, handler: Handler) => () => void;
    /**
     * Runs `handler` whenever messages may have been missed, such as once Verso hears them again
     * after its connection dropped, until the function returned is called.
     */
    readonly onMissed: (handler: () => Promise<void>) => () => void;
};

/** What every service gets as its first argument. Ports join it as they are added. */
export type Context<DB = Database> = {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly urls: UrlBuilder;
    readonly transport: Transport;
    /** Where uploaded files are stored. */
    readonly files: FileStore;
    /** Processes uploaded images so they are ready to store and display. */
    readonly images: ImageProcessor;
    /** One for each configured issuer, by issuer URL. */
    readonly identityProviders: Readonly<Record<string, IdentityProvider>>;
    readonly federation: Federation;
    /** What config says services do, such as how long to retain jobs. */
    readonly settings: Settings;
    /** Every subscriber, each notified of every event, such as one for each protocol. */
    readonly subscribers: readonly Subscriber[];
    /** Sends messages to every process, through `publish` and `subscribe`. */
    readonly pubsub: PubSub;
    /**
     * Aborts the requests to remote instances made with this context when it aborts, such as when a
     * client's request has waited long enough.
     */
    readonly signal?: AbortSignal;
    /** The database, or the current transaction inside `transaction`. */
    readonly db: Kysely<DB>;
    /**
     * Runs `work` as one unit: its writes, and the jobs it enqueues, all commit when it resolves,
     * or none do when it throws. Inside a transaction, a nested call joins the outer one rather
     * than starting its own, so one failure undoes the whole unit.
     */
    transaction<T>(work: (tx: Context<DB>) => Promise<T>): Promise<T>;
    /**
     * Runs `work` once the current transaction commits, before `transaction` resolves, or at once
     * outside one. It isn't run if the transaction rolls back. It is for telling what committed,
     * such as to other processes, so a failure is logged rather than failing what committed.
     */
    afterCommit(work: () => Promise<void>): Promise<void>;
};

/** Runs `work`, logging rather than throwing if it fails. */
const runCommitted = async (work: () => Promise<void>) => {
    try {
        await work();
    } catch (error) {
        getLogger(["verso", "kernel"]).error("Failed after a commit: {error}", { error });
    }
};

/** A context whose `afterCommit` queues work in `committed`, if it is in a transaction. */
const contextIn = <DB>(
    parts: Omit<Context<DB>, "transaction" | "afterCommit">,
    committed: (() => Promise<void>)[] | undefined,
): Context<DB> => {
    const context: Context<DB> = {
        ...parts,
        transaction: async (work) => {
            if (parts.db.isTransaction) return await work(context);

            const queued: (() => Promise<void>)[] = [];
            const result = await parts.db.transaction()
                .execute((db) => work(contextIn({ ...parts, db }, queued)));
            for (const each of queued) await runCommitted(each);

            return result;
        },
        afterCommit: async (work) => {
            if (committed === undefined) await runCommitted(work);
            else committed.push(work);
        },
    };

    return context;
};

export const createContext = <DB = Database>(
    parts: Omit<Context<DB>, "transaction" | "afterCommit">,
): Context<DB> => contextIn(parts, undefined);
