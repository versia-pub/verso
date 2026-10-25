import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";
import type { InstancesTable } from "./tables.ts";

/** The id of the instance at `domain`, if Verso knows it. */
export const findInstanceId = async (ctx: Context, domain: string): Promise<string | undefined> =>
    (await ctx.db.selectFrom("instances").select("id").where("domain", "=", domain)
        .executeTakeFirst())?.id;

/** Whether the instance at `domain` takes instance messages, as it last said. */
export const takesMessages = async (ctx: Context, domain: string): Promise<boolean> =>
    (await ctx.db.selectFrom("instances").select("takes_messages").where("domain", "=", domain)
        .executeTakeFirst())?.takes_messages === true;

/** How many other instances this one knows of. */
export const countInstances = async (ctx: Context): Promise<number> =>
    readCount(await ctx.db.selectFrom("instances").select(countAll).executeTakeFirstOrThrow());

/** The domains of the instances `ids` that are on `protocol`, sorted. */
export const domainsOf = async (
    ctx: Context,
    ids: readonly string[],
    protocol: InstancesTable["protocol"],
): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("instances").select("domain")
        .where("id", "in", ids)
        .where("protocol", "=", protocol)
        .orderBy("domain")
        .execute();

    return rows.map((row) => row.domain);
};

/**
 * The domains of the instances `ids` that are on `protocol`, sorted, but for those that couldn't
 * be reached since `before` or earlier.
 */
export const reachableDomainsOf = async (
    ctx: Context,
    ids: readonly string[],
    protocol: InstancesTable["protocol"],
    before: Date,
): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("instances").select("domain")
        .where("id", "in", ids)
        .where("protocol", "=", protocol)
        .where((eb) =>
            eb.or([eb("unreachable_since", "is", null), eb("unreachable_since", ">", before)])
        )
        .orderBy("domain")
        .execute();

    return rows.map((row) => row.domain);
};
