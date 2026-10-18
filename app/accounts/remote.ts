/**
 * Accounts on other instances, as Verso keeps them.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { deleteMedia, type RemoteMedia, saveRemoteMedia } from "../media/media.ts";
import { type RemoteProfile, setAccountPictures, upsertRemoteAccount } from "./accounts.ts";

/** A remote account as its instance last described it, whatever protocol it used. */
export type RemoteAccount = {
    /** In `instances`. */
    readonly instanceId: string;
    /** Its id on its instance. */
    readonly remoteId: string;
    readonly createdAt: Date;
    readonly profile: RemoteProfile;
    readonly avatar: RemoteMedia | null;
    readonly header: RemoteMedia | null;
};

/**
 * Saves a remote account, replacing what was known of it, and returns its id here. Its pictures
 * are saved over the ones it had, and one it no longer has is deleted. Saving the same account
 * again changes nothing but when it was fetched, so receiving it twice is harmless.
 */
export const saveRemoteAccount = (ctx: Context, account: RemoteAccount): Promise<string> =>
    ctx.transaction(async (tx) => {
        const saved = await upsertRemoteAccount(tx, account);

        const picture = async (current: string | null, media: RemoteMedia | null) => {
            if (media) return await saveRemoteMedia(tx, account.instanceId, current, media);
            if (current !== null) await deleteMedia(tx, current);
            return null;
        };

        const pictures = {
            avatar_id: await picture(saved.avatar_id, account.avatar),
            header_id: await picture(saved.header_id, account.header),
        };
        if (pictures.avatar_id !== saved.avatar_id || pictures.header_id !== saved.header_id) {
            await setAccountPictures(tx, saved.id, pictures);
        }

        return saved.id;
    });
