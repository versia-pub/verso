import type { Context } from "../kernel/context.ts";

/**
 * Until when `domain` is parked, or `null` if it isn't, or `undefined` if Verso doesn't have it.
 */
export const findParkedUntil = async (
    ctx: Context,
    domain: string,
): Promise<Date | null | undefined> =>
    (await ctx.db.selectFrom("instances").select("parked_until")
        .where("domain", "=", domain).executeTakeFirst())?.parked_until;

/**
 * Parks `domain` until `hold`, if its wait was over by `now`, so that one probe may go. Returns
 * whether it did, which only one of those asking at the same moment does.
 */
export const holdForProbe = async (
    ctx: Context,
    domain: string,
    now: Date,
    hold: Date,
): Promise<boolean> =>
    await ctx.db.updateTable("instances")
        .set({ parked_until: hold })
        .where("domain", "=", domain)
        .where("parked_until", "<=", now)
        .returning("id")
        .executeTakeFirst() !== undefined;

/**
 * Counts a failure to reach `domain`, recording since when it couldn't be reached if it could
 * before. Returns how many failures in a row it has, if Verso has the instance.
 */
export const addFailure = async (ctx: Context, domain: string): Promise<number | undefined> =>
    (await ctx.db.updateTable("instances")
        .set((eb) => ({
            failures: eb("failures", "+", 1),
            unreachable_since: eb.fn.coalesce("unreachable_since", eb.val(ctx.clock.now())),
        }))
        .where("domain", "=", domain)
        .returning("failures")
        .executeTakeFirst())?.failures;

/** Parks `domain` until `until`. */
export const setParkedUntil = async (ctx: Context, domain: string, until: Date): Promise<void> => {
    await ctx.db.updateTable("instances").set({ parked_until: until })
        .where("domain", "=", domain).execute();
};

/** Clears `domain`'s failures and parking. Returns whether it had any. */
export const clearFailures = async (ctx: Context, domain: string): Promise<boolean> =>
    await ctx.db.updateTable("instances")
        .set({ failures: 0, parked_until: null, unreachable_since: null })
        .where("domain", "=", domain)
        .where((eb) => eb.or([eb("failures", ">", 0), eb("parked_until", "is not", null)]))
        .returning("id")
        .executeTakeFirst() !== undefined;
