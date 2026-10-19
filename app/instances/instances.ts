import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";
import type { InstancesTable } from "./tables.ts";

/** The id of the instance at `domain`, if Verso knows it. */
export const findInstanceId = async (ctx: Context, domain: string): Promise<string | undefined> =>
    (await ctx.db.selectFrom("instances").select("id").where("domain", "=", domain)
        .executeTakeFirst())?.id;

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
