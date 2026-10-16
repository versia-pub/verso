import type { Context } from "../kernel/context.ts";

/** A Versia instance with no key yet, for tests that need remote accounts. Its id is its domain. */
export const createInstance = async (ctx: Context, domain: string): Promise<string> => {
    await ctx.db.insertInto("instances")
        .values({
            id: domain,
            domain,
            protocol: "versia",
            public_key: null,
            key_fetched_at: null,
            created_at: ctx.clock.now(),
        })
        .execute();

    return domain;
};
