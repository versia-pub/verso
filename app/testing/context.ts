import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import { ensureInstanceKey } from "../instances/keys.ts";
import { ensureVapidKey } from "../push/keys.ts";
import { migrated, migratedTestDatabase } from "../db/testing.ts";
import { type FakeClock, fakeClock } from "../kernel/clock.ts";
import { defaultSettings, type Settings } from "../kernel/settings.ts";
import {
    type Context,
    createContext,
    type Federation,
    type PubSub,
    type Subscriber,
} from "../kernel/context.ts";
import { type FileStore, memoryFiles } from "../kernel/files.ts";
import { memoryPubSub } from "../kernel/pubsub.ts";
import type { ImageProcessor } from "../kernel/images.ts";
import type { IdentityProvider } from "../kernel/identity.ts";
import { type FakeTransport, fakeTransport } from "../kernel/fake_transport.ts";
import { countingRandom, idGenerator } from "../kernel/ids.ts";
import { urlBuilder } from "../kernel/urls.ts";
import { vipsImages } from "../kernel/vips_images.ts";
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
    /** Defaults to vips, with Mastodon's limit on pixels. */
    readonly images?: ImageProcessor;
    /** Defaults to a new test database. It is migrated, and closed on disposal. */
    readonly db?: Kysely<Database>;
    /** Defaults to none. */
    readonly identityProviders?: Readonly<Record<string, IdentityProvider>>;
    /** Defaults to Verso's own, with a key store of its own and no domains blocked by config. */
    readonly federation?: Partial<Federation>;
    /** Defaults to Verso's own. */
    readonly subscribers?: readonly Subscriber[];
    /** Defaults to a new one in memory. */
    readonly pubsub?: PubSub;
    /** Defaults to those of a config that leaves them out. */
    readonly settings?: Partial<Settings>;
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
    const db = options.db ? await migrated(options.db) : await migratedTestDatabase<Database>();

    const clock = options.clock ?? fakeClock();

    // Their own ids, so generating the keys doesn't shift the ids tests expect.
    await ensureInstanceKey({ db, clock, ids: idGenerator(clock) });
    await ensureVapidKey({ db, clock, ids: idGenerator(clock) });

    const transport = options.transport ?? fakeTransport();
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder(options.domain ?? "social.example"),
        transport,
        files: options.files ?? memoryFiles(),
        images: options.images ?? vipsImages({ maxPixels: 8_294_400 }),
        identityProviders: options.identityProviders ?? {},
        federation: { ...federation(), ...options.federation },
        settings: { ...defaultSettings, ...options.settings },
        subscribers: options.subscribers ?? subscribers,
        pubsub: options.pubsub ?? memoryPubSub(),
        db,
    });

    return { ctx, clock, transport, [Symbol.asyncDispose]: () => db.destroy() };
};
