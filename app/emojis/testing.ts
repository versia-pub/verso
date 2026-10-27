import type { Context } from "../kernel/context.ts";

/**
 * A global emoji of the local instance, with its picture processed and stored under the
 * key `emoji-<shortcode>`, though no file is stored. Returns its id.
 */
export const createLocalEmoji = async (ctx: Context, shortcode: string): Promise<string> => {
    const mediaId = ctx.ids();
    await ctx.db.insertInto("media")
        .values({
            id: mediaId,
            instance_id: null,
            url: null,
            media_type: "image/png",
            sha256: `emoji-${shortcode}`,
            processed_at: ctx.clock.now(),
            created_at: ctx.clock.now(),
        })
        .execute();

    const id = ctx.ids();
    await ctx.db.insertInto("emojis")
        .values({
            id,
            instance_id: null,
            shortcode,
            media_id: mediaId,
            created_at: ctx.clock.now(),
        })
        .execute();

    return id;
};
