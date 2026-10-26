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

/** What an instance's metadata said when it was last fetched. */
export type InstanceMetadataColumns = {
    readonly public_key: string;
    readonly key_fetched_at: Date;
    readonly takes_messages: boolean;
};

/** Keeps an instance's fetched metadata in its row, which it creates if there is none yet. */
export const saveInstanceMetadata = async (
    ctx: Context,
    domain: string,
    metadata: InstanceMetadataColumns,
): Promise<void> => {
    await ctx.db.insertInto("instances")
        .values({
            id: ctx.ids(),
            domain,
            protocol: "versia",
            ...metadata,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.column("domain").doUpdateSet(metadata))
        .execute();
};

/** The key Verso has for the instance at `domain`, and when it was fetched, if it knows it. */
export const findStoredKey = (
    ctx: Context,
    domain: string,
): Promise<Pick<InstancesTable, "public_key" | "key_fetched_at"> | undefined> =>
    ctx.db.selectFrom("instances")
        .select(["public_key", "key_fetched_at"])
        .where("domain", "=", domain)
        .executeTakeFirst();
