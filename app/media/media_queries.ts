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

/** The columns for what a remote instance said about its media, with omitted fields cleared. */
const claimsOf = (media: RemoteMedia) => ({
    url: media.url,
    media_type: media.mediaType,
    size: media.size ?? null,
    remote_sha256: media.sha256 ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    thumbhash: media.thumbhash ?? null,
    description: media.description ?? null,
});

/** The columns that caching sets, cleared, as remote media is until its file is cached. */
const uncached = {
    sha256: null,
    preview_sha256: null,
    preview_width: null,
    preview_height: null,
    blurhash: null,
    cached_type: null,
    processed_at: null,
};

/**
 * Remote media as saved: its id, whether its file still has to be cached, and the keys of cached
 * files it stopped using, which may now be unused.
 */
export type SavedRemoteMedia = {
    readonly id: string;
    readonly uncached: boolean;
    readonly unused: readonly (string | null)[];
};

/**
 * Stores remote media for the instance `instanceId`. If `current` is given, it is updated in place
 * so the rows that reference it needn't change; otherwise a new media row is created. Media at the
 * same URL with the same hash is the same file, so what caching found is kept, and only its
 * description can change; another file clears it.
 */
export const storeRemoteMedia = async (
    ctx: Context,
    instanceId: string,
    current: string | null,
    media: RemoteMedia,
): Promise<SavedRemoteMedia> => {
    const claims = claimsOf(media);
    if (current !== null) {
        const before = await ctx.db.selectFrom("media")
            .select(["url", "remote_sha256", "sha256", "preview_sha256", "processed_at"])
            .where("id", "=", current)
            .where("instance_id", "=", instanceId)
            .executeTakeFirst();
        if (before === undefined) return { id: current, uncached: false, unused: [] };

        const same = before.url === claims.url && before.remote_sha256 === claims.remote_sha256;
        if (same && before.processed_at !== null) {
            await ctx.db.updateTable("media")
                .set({ description: claims.description })
                .where("id", "=", current)
                .execute();

            return { id: current, uncached: false, unused: [] };
        }

        await ctx.db.updateTable("media")
            .set({ ...claims, ...!same && uncached })
            .where("id", "=", current)
            .execute();

        return {
            id: current,
            uncached: true,
            unused: same ? [] : [before.sha256, before.preview_sha256],
        };
    }

    const id = ctx.ids();
    await ctx.db.insertInto("media")
        .values({ id, instance_id: instanceId, created_at: ctx.clock.now(), ...claims })
        .execute();

    return { id, uncached: true, unused: [] };
};

/** The media row `id`, or `undefined` if there is none. */
export const findMedia = (ctx: Context, id: string): Promise<MediaRow | undefined> =>
    ctx.db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();

/**
 * Deletes the media `ids`, which nothing may reference any more, and returns the keys of the files
 * they stored, which may now be unused.
 */
export const deleteMediaAmong = async (
    ctx: Context,
    ids: readonly string[],
): Promise<(string | null)[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.deleteFrom("media")
        .where("id", "in", ids)
        .returning(["sha256", "preview_sha256"])
        .execute();

    return rows.flatMap((row) => [row.sha256, row.preview_sha256]);
};
