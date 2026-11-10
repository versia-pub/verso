/**
 * Deleting local accounts, as whoever runs the instance does. A deleted account is kept, empty and
 * suspended, so its username and login can't be used again, unless it is removed altogether.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/services/delete_account_service.rb
 * @module
 */
import { deleteAccount, emptyAccount } from "../accounts/account_queries.ts";
import type { AccountDeleting } from "../accounts/events.ts";
import { deleteEmojisOf } from "../emojis/emojis.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { deleteFileIfUnused } from "../media/cleanup.ts";
import { deleteMediaOf } from "../media/upload_queries.ts";
import { removeNotesOf } from "../notes/removal.ts";
import { purgeRowsOf } from "./account_deletion_queries.ts";
import { suspend } from "./suspensions.ts";

/**
 * Deletes the local account `accountId`: suspends it, so its sessions end, then deletes its
 * statuses, media, emojis, follows and everything else it has, keeping its login and the reports by
 * and about it. With `tombstone` false, the account is removed too, with its login and reports, so
 * the username and login can be used again. Deleting an account again finishes a deletion that
 * stopped part way. Returns whether it wasn't deleted already.
 */
export const deleteLocalAccount = async (
    ctx: Context,
    accountId: string,
    { tombstone }: { readonly tombstone: boolean },
): Promise<boolean> => {
    await suspend(ctx, accountId);
    await removeNotesOf(ctx, accountId);

    const { deleted, keys } = await ctx.transaction(async (tx) => {
        const event: AccountDeleting = { type: "accounts.deleting", accountId };
        await emit(tx, event);
        await deleteEmojisOf(tx, accountId);
        await purgeRowsOf(tx, accountId);
        const deleted = tombstone ? await emptyAccount(tx, accountId, tx.clock.now()) : true;
        const keys = await deleteMediaOf(tx, accountId);
        if (!tombstone) await deleteAccount(tx, accountId);

        return { deleted, keys };
    });
    for (const key of keys) await deleteFileIfUnused(ctx, key);

    return deleted;
};
