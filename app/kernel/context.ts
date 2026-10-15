import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import type { Clock } from "./clock.ts";
import type { IdentityProvider } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import type { Transport } from "./transport.ts";
import type { UrlBuilder } from "./urls.ts";

/** What every service gets as its first argument. Ports join it as they are added. */
export type Context<DB = Database> = {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly urls: UrlBuilder;
    readonly transport: Transport;
    /** One for each configured issuer, by issuer URL. */
    readonly identityProviders: Readonly<Record<string, IdentityProvider>>;
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
