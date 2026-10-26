import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { MediaTable } from "./tables.ts";

export type MediaRow = Selectable<MediaTable>;

/**
 * A file on another instance, as Verso keeps it whatever protocol described it. Only one version
 * of it is kept, even if its instance offered several.
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

/** The columns for a remote file, with what it leaves out cleared. */
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
 * Keeps a remote file on the instance `instanceId`: in place of the file `current`, if there is
 * one, so that the row pointing at it needn't change, or else as a new file. Returns its id.
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

/** The file `id`, or `undefined` if there is none. */
export const findMedia = (ctx: Context, id: string): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();

/** Deletes a file. Nothing may point at it any more. */
export const deleteMedia = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("media").where("id", "=", id).execute();
};
