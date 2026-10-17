import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";

/** How many other instances this one knows of. */
export const countInstances = async (ctx: Context): Promise<number> =>
    readCount(await ctx.db.selectFrom("instances").select(countAll).executeTakeFirstOrThrow());
