import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { ensureInstanceKey } from "../instances/keys.ts";
import { testDatabase } from "../db/testing.ts";
import { type FakeClock, fakeClock } from "../kernel/clock.ts";
import {
    type Context,
    createContext,
    type Federation,
    type Subscriber,
} from "../kernel/context.ts";
import { type FileStore, memoryFiles } from "../kernel/files.ts";
import type { IdentityProvider } from "../kernel/identity.ts";
import { type FakeTransport, fakeTransport } from "../kernel/fake_transport.ts";
import { countingRandom, idGenerator } from "../kernel/ids.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { federation, subscribers } from "../services.ts";

export type TestContextOptions = {
    /** Defaults to `social.example`. */
    readonly domain?: string;
    /** Defaults to a new fake clock. */
    readonly clock?: FakeClock;
    /** Defaults to a network with no other servers on it. */
    readonly transport?: FakeTransport;
    /** Defaults to a new, empty store in memory. */
    readonly files?: FileStore;
    /** Defaults to a new, empty test database. It is migrated, and closed on disposal. */
    readonly db?: Kysely<Database>;
    /** Defaults to none. */
    readonly identityProviders?: Readonly<Record<string, IdentityProvider>>;
    /** Defaults to Verso's own, with a key store of its own and no domains blocked by config. */
    readonly federation?: Partial<Federation>;
    /** Defaults to Verso's own. */
    readonly subscribers?: readonly Subscriber[];
};

export type TestContext = AsyncDisposable & {
    readonly ctx: Context;
    readonly clock: FakeClock;
    readonly transport: FakeTransport;
};

/**
 * A context for one test: a migrated database, a clock that moves only when told to, ids that are
 * the same on every run, and a fake network. Use it with `await using`, so the database closes
 * afterwards.
 */
export const createTestContext = async (
    options: TestContextOptions = {},
): Promise<TestContext> => {
    const db = options.db ?? await testDatabase<Database>();

    const migrated = await migrate(db);
    if (!migrated.ok) {
        await db.destroy();
        throw migrated.error;
    }

    const clock = options.clock ?? fakeClock();

    // Its own ids, so making the key doesn't shift the ids tests expect.
    await ensureInstanceKey({ db, clock, ids: idGenerator(clock) });

    const transport = options.transport ?? fakeTransport();
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder(options.domain ?? "social.example"),
        transport,
        files: options.files ?? memoryFiles(),
        identityProviders: options.identityProviders ?? {},
        federation: { ...federation(), ...options.federation },
        subscribers: options.subscribers ?? subscribers,
        db,
    });

    return { ctx, clock, transport, [Symbol.asyncDispose]: () => db.destroy() };
};
