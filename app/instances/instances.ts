import type { Context } from "../kernel/context.ts";

/** How many other instances this one knows of. */
export const countInstances = async (ctx: Context): Promise<number> => {
    const { count } = await ctx.db.selectFrom("instances")
        .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
        .executeTakeFirstOrThrow();

    return Number(count);
};
