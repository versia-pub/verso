import { Instance, Limits } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import type { AboutSettings } from "./routes.ts";

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

/** The config's defaults for what the routes need, with no issuers. */
export const defaultSettings = (): AboutSettings => ({
    instance: Instance.parse({}),
    limits: Limits.parse({}),
    auth: { issuers: [], dev_login: false },
});
