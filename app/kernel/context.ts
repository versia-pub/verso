import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import type { Clock } from "./clock.ts";
import type { IdentityProvider } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import type { Transport } from "./transport.ts";
import type { UrlBuilder } from "./urls.ts";

/** Other instances' public keys, by domain. */
export type KeyStore = {
    /** The key Verso has for the instance, or else fetches from it. */
    readonly get: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
    /** Fetches the key again, in case the instance rotated it, but only so often. */
    readonly refresh: (ctx: Context, domain: string) => Promise<CryptoKey | undefined>;
};

/** What talking to other instances needs: whose keys to sign and check with, and whom to ignore. */
export type Federation = {
    /** This instance's private key. */
    readonly signingKey: (ctx: Context) => Promise<CryptoKey>;
    /** One store for the whole process, so each key is fetched once. */
    readonly remoteKeys: KeyStore;
    /** Whether Verso doesn't federate with an instance, by its domain. */
    readonly isBlocked: (ctx: Context, domain: string) => Promise<boolean>;
};

/** What every service gets as its first argument. Ports join it as they are added. */
export type Context<DB = Database> = {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly urls: UrlBuilder;
    readonly transport: Transport;
    /** One for each configured issuer, by issuer URL. */
    readonly identityProviders: Readonly<Record<string, IdentityProvider>>;
    readonly federation: Federation;
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
