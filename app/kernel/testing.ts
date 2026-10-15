import type { Kysely } from "kysely";
import type { Database } from "../db/database.ts";
import { migrate } from "../db/migrate.ts";
import { testDatabase } from "../db/testing.ts";
import { type FakeClock, fakeClock } from "./clock.ts";
import { type Context, createContext } from "./context.ts";
import { countingRandom, idGenerator } from "./ids.ts";
import { urlBuilder } from "./urls.ts";

export type TestContextOptions = {
    /** Defaults to `social.example`. */
    readonly domain?: string;
    /** Where the fake clock starts. */
    readonly now?: Date;
    /** Defaults to a new, empty test database. It is migrated, and closed on disposal. */
    readonly db?: Kysely<Database>;
};

export type TestContext = AsyncDisposable & {
    readonly ctx: Context;
    readonly clock: FakeClock;
};

/**
 * A context for one test: a migrated database, a clock that moves only when told to, and ids that
 * are the same on every run. Use it with `await using`, so the database closes afterwards.
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
    const clock = fakeClock(options.now);
    const ctx = createContext({
        clock,
        ids: idGenerator(clock, countingRandom()),
        urls: urlBuilder(options.domain ?? "social.example"),
        db,
    });
    return { ctx, clock, [Symbol.asyncDispose]: () => db.destroy() };
};
