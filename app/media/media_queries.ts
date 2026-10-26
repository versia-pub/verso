import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MediaTable } from "./tables.ts";

export type MediaRow = Selectable<MediaTable>;

/**
 * Remote media, stored the same way whichever protocol described it. Only one version is stored,
 * even if the remote instance offered several.
 */
export type RemoteMedia = {
    readonly url: string;
    readonly mediaType: string;
    readonly size?: number;
    /** In hex. */
    readonly sha256?: string;
    readonly width?: number;
    readonly height?: number;
    readonly thumbhash?: string;
    readonly description?: string;
};

/** The columns for remote media, with omitted fields cleared. */
const columnsOf = (media: RemoteMedia) => ({
    url: media.url,
    media_type: media.mediaType,
    size: media.size ?? null,
    sha256: media.sha256 ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    thumbhash: media.thumbhash ?? null,
    description: media.description ?? null,
});

/**
 * Stores remote media for the instance `instanceId`. If `current` is given, it is updated in place
 * so the rows that reference it needn't change; otherwise a new media row is created. Returns its
 * id.
 */
export const saveRemoteMedia = async (
    ctx: Context,
    instanceId: string,
    current: string | null,
    media: RemoteMedia,
): Promise<string> => {
    if (current !== null) {
        await ctx.db.updateTable("media")
            .set(columnsOf(media))
            .where("id", "=", current)
            .where("instance_id", "=", instanceId)
            .execute();

        return current;
    }

    const id = ctx.ids();
    await ctx.db.insertInto("media")
        .values({ id, instance_id: instanceId, created_at: ctx.clock.now(), ...columnsOf(media) })
        .execute();

    return id;
};

/** The media row `id`, or `undefined` if there is none. */
export const findMedia = (ctx: Context, id: string): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();

/** Deletes a media row. Nothing may reference it any more. */
export const deleteMedia = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("media").where("id", "=", id).execute();
};
