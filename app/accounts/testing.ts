import type { Context } from "../kernel/context.ts";

/** A local account, for tests that skip logging in. Its id is its username. */
export const createLocalAccount = async (ctx: Context, username: string): Promise<string> => {
    await ctx.db.insertInto("accounts")
        .values({
            id: username,
            username,
            instance_id: null,
            remote_id: null,
            created_at: ctx.clock.now(),
        })
        .execute();

    return username;
};
