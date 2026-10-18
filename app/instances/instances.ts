import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";

/** The id of the instance at `domain`, if Verso knows it. */
export const findInstanceId = async (ctx: Context, domain: string): Promise<string | undefined> =>
    (await ctx.db.selectFrom("instances").select("id").where("domain", "=", domain)
        .executeTakeFirst())?.id;

/** How many other instances this one knows of. */
export const countInstances = async (ctx: Context): Promise<number> =>
    readCount(await ctx.db.selectFrom("instances").select(countAll).executeTakeFirstOrThrow());
