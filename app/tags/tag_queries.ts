import { batchesOf } from "../db/batches.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Adds the hashtags of `names`, written without their `#`, that aren't known yet, as they are
 * written. Of several that differ only in case, the first is kept.
 */
export const insertTags = async (ctx: Context, names: readonly string[]): Promise<void> => {
    const byName = new Map<string, string>();
    for (const name of names) {
        if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), name);
    }

    for (const batch of batchesOf([...byName])) {
        await ctx.db.insertInto("tags")
            .values(batch.map(([name, display_name]) => ({ name, display_name })))
            .onConflict((conflict) => conflict.column("name").doNothing())
            .execute();
    }
};

/** How each of `names`, in lower case, was first written, for those that are known. */
export const displayNamesOf = async (
    ctx: Context,
    names: readonly string[],
): Promise<Map<string, string>> => {
    if (names.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("tags").selectAll()
        .where("name", "in", [...new Set(names)])
        .execute();
    return new Map(rows.map((row) => [row.name, row.display_name]));
};
