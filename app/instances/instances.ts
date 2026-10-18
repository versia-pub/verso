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

/** The domains of the instances on `protocol` that host any of the accounts `accountIds`. */
export const domainsHosting = async (
    ctx: Context,
    accountIds: readonly string[],
    protocol: InstancesTable["protocol"],
): Promise<string[]> => {
    if (accountIds.length === 0) return [];

    const rows = await ctx.db.selectFrom("accounts")
        .innerJoin("instances", "instances.id", "accounts.instance_id")
        .select("instances.domain")
        .distinct()
        .where("accounts.id", "in", accountIds)
        .where("instances.protocol", "=", protocol)
        .orderBy("instances.domain")
        .execute();

    return rows.map((row) => row.domain);
};
