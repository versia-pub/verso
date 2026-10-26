/**
 * Remote accounts, as Verso stores them.
 * @module
 */
import { setAccountEmojis } from "../emojis/emoji_queries.ts";
import { keepRemoteEmojis, type RemoteEmoji } from "../emojis/emojis.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { deleteMedia, type RemoteMedia, saveRemoteMedia } from "../media/media_queries.ts";
import type { AccountDeleting } from "./events.ts";
import {
    deleteAccount,
    findRemoteAccount,
    releaseRemoteUsername,
    type RemoteProfile,
    setAccountPictures,
    upsertRemoteAccount,
} from "./account_queries.ts";

/** A remote account as its instance last described it, whichever protocol it used. */
export type RemoteAccount = {
    /** In `instances`. */
    readonly instanceId: string;
    /** Its id on its instance. */
    readonly remoteId: string;
    readonly createdAt: Date;
    readonly profile: RemoteProfile;
    readonly avatar: RemoteMedia | null;
    readonly header: RemoteMedia | null;
    /** The custom emojis used in its display name, bio and fields. */
    readonly emojis: readonly RemoteEmoji[];
};

/**
 * Saves a remote account, replacing what was stored for it, and returns its local id. Its username
 * is taken from any account Verso had with it, which is fetched again later. Its pictures are saved
 * over the ones it had, and a picture it no longer has is deleted. The custom emojis it uses
 * replace the ones it used. Saving the same account again changes nothing but the time it was
 * fetched, so receiving it twice is harmless.
 */
export const saveRemoteAccount = (ctx: Context, account: RemoteAccount): Promise<string> =>
    ctx.transaction(async (tx) => {
        await releaseRemoteUsername(tx, account.instanceId, account.profile.username);
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
        await setAccountEmojis(
            tx,
            saved.id,
            await keepRemoteEmojis(tx, account.instanceId, account.emojis),
        );

        return saved.id;
    });

/**
 * Deletes a remote account, by its id on its instance, with its pictures, if Verso has it. Other
 * modules are notified first, to decrement the counts that depend on it.
 */
export const deleteRemoteAccount = (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> =>
    ctx.transaction(async (tx) => {
        const account = await findRemoteAccount(tx, instanceId, remoteId);
        if (!account) return;

        const event: AccountDeleting = { type: "accounts.deleting", accountId: account.id };
        await emit(tx, event);
        await deleteAccount(tx, account.id);
        for (const picture of [account.avatar_id, account.header_id]) {
            if (picture !== null) await deleteMedia(tx, picture);
        }
    });
