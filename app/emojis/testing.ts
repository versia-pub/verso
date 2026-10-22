import type { Context } from "../kernel/context.ts";

/**
 * One of this instance's emojis, with its picture at `url`, for tests until emojis can be made.
 * Returns its id.
 */
export const createLocalEmoji = async (
    ctx: Context,
    shortcode: string,
    url = `https://pictures.example/${shortcode}.png`,
): Promise<string> => {
    const mediaId = ctx.ids();
    await ctx.db.insertInto("media")
        .values({
            id: mediaId,
            instance_id: null,
            url,
            media_type: "image/png",
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
