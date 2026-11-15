/**
 * Remote accounts, as Verso stores them.
 * @module
 */
import { setAccountEmojis } from "../emojis/emoji_queries.ts";
import { keepRemoteEmojis, type RemoteEmoji } from "../emojis/emojis.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { RemoteMedia } from "../media/media_queries.ts";
import { deleteRemoteMedia, saveRemoteMedia } from "../media/remote_cache.ts";
import type { AccountDeleting, AccountReceived } from "./events.ts";
import {
    type AccountDecoration,
    type AccountPictures,
    deleteAccounts,
    findAccountDecorations,
    findDecorationMedia,
    findRemoteAccount,
    releaseRemoteUsername,
    type RemoteProfile,
    replaceAccountDecorations,
    setAccountPictures,
    upsertRemoteAccount,
} from "./account_queries.ts";
import type { DecorationKind } from "./tables.ts";

/** One of a remote account's decorations, in the slot of `kind` and `position`. */
export type RemoteDecoration = {
    readonly kind: DecorationKind;
    readonly position: number;
    readonly media: RemoteMedia;
};

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
    /** Its decorations apart from the header, each in its own slot. */
    readonly decorations: readonly RemoteDecoration[];
    /** The custom emojis used in its display name, bio and fields. */
    readonly emojis: readonly RemoteEmoji[];
};

/**
 * Saves the decorations of the remote account `accountId`. A slot that had media keeps its row, so
 * that what is cached of it is kept. Slots the account no longer has are deleted, with their media.
 */
const saveDecorations = async (ctx: Context, account: RemoteAccount, accountId: string) => {
    const slot = (decoration: Pick<AccountDecoration, "kind" | "position">) =>
        `${decoration.kind}:${decoration.position}`;

    const before = await findAccountDecorations(ctx, accountId);
    const current = new Map(before.map((decoration) => [slot(decoration), decoration.media_id]));

    const after: AccountDecoration[] = [];
    for (const { kind, position, media } of account.decorations) {
        const existing = current.get(slot({ kind, position })) ?? null;
        const media_id = await saveRemoteMedia(ctx, account.instanceId, existing, media);
        after.push({ kind, position, media_id });
    }

    // A slot keeps its media, so the slots are the same if each has the media it had.
    const unchanged = before.length === after.length &&
        after.every((decoration) => current.get(slot(decoration)) === decoration.media_id);
    if (unchanged) return;

    const kept = new Set(after.map((decoration) => decoration.media_id));
    const gone = before.map((decoration) => decoration.media_id).filter((id) => !kept.has(id));

    // The rows go first, as they refer to the media.
    await replaceAccountDecorations(ctx, accountId, after);
    await deleteRemoteMedia(ctx, gone);
};

/**
 * Saves a remote account, replacing what was stored for it, and returns its local id. Its username
 * is taken from any account Verso had with it, which is fetched again later. Its pictures and
 * decorations are saved over the ones it had, and any it no longer has is deleted. The custom
 * emojis it uses replace the ones it used. Saving the same account again changes nothing but the
 * time it was fetched, so receiving it twice is harmless. It is emitted either way.
 */
export const saveRemoteAccount = (ctx: Context, account: RemoteAccount): Promise<string> =>
    ctx.transaction(async (tx) => {
        await releaseRemoteUsername(tx, account.instanceId, account.profile.username);
        const saved = await upsertRemoteAccount(tx, account);

        const picture = async (current: string | null, media: RemoteMedia | null) => {
            if (media) return await saveRemoteMedia(tx, account.instanceId, current, media);
            if (current !== null) await deleteRemoteMedia(tx, [current]);
            return null;
        };

        const pictures = {
            avatar_id: await picture(saved.avatar_id, account.avatar),
            header_id: await picture(saved.header_id, account.header),
        };
        if (pictures.avatar_id !== saved.avatar_id || pictures.header_id !== saved.header_id) {
            await setAccountPictures(tx, saved.id, pictures);
        }
        await saveDecorations(tx, account, saved.id);
        await setAccountEmojis(
            tx,
            saved.id,
            await keepRemoteEmojis(tx, account.instanceId, account.emojis),
        );

        const received: AccountReceived = { type: "accounts.received", accountId: saved.id };
        await emit(tx, received);

        return saved.id;
    });

/**
 * Deletes a remote account, by its id on its instance, with its pictures and decorations, if Verso
 * has it. Other modules are notified first, to decrement the counts that depend on it.
 */
export const deleteRemoteAccount = (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> =>
    ctx.transaction(async (tx) => {
        const account = await findRemoteAccount(tx, instanceId, remoteId);
        if (account) await removeRemoteAccounts(tx, [account]);
    });

/**
 * Deletes remote accounts with their pictures and decorations, as {@link deleteRemoteAccount} does,
 * in the caller's transaction, all in one statement after other modules are notified of each.
 */
export const removeRemoteAccounts = async (
    ctx: Context,
    accounts: readonly AccountPictures[],
): Promise<void> => {
    if (accounts.length === 0) return;

    for (const account of accounts) {
        const event: AccountDeleting = { type: "accounts.deleting", accountId: account.id };
        await emit(ctx, event);
    }
    const ids = accounts.map((account) => account.id);
    // Deleting the accounts deletes the rows that list their decorations.
    const decorations = await findDecorationMedia(ctx, ids);
    await deleteAccounts(ctx, ids);
    const pictures = accounts.flatMap((account) => [account.avatar_id, account.header_id])
        .filter((picture) => picture !== null);
    await deleteRemoteMedia(ctx, [...pictures, ...decorations]);
};
