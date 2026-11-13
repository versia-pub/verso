/**
 * Deleting local accounts, for admins and moderators. A deleted account is kept, empty and
 * suspended, so its username and login can't be used again, unless it is removed altogether.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/services/delete_account_service.rb
 * @module
 */
import { z } from "zod";
import { deleteAccount, emptyAccount } from "../accounts/account_queries.ts";
import type { AccountDeleting } from "../accounts/events.ts";
import { deleteEmojisOf } from "../emojis/emojis.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { deleteEntity } from "../federation/delete.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import { deleteFileIfUnused } from "../media/cleanup.ts";
import { deleteMediaOf } from "../media/upload_queries.ts";
import { removeNotesOf } from "../notes/removal.ts";
import { purgeRowsOf } from "./account_deletion_queries.ts";
import { suspend } from "./suspensions.ts";

/**
 * Deletes the local account `accountId`. It is suspended first, so its sessions end, then its
 * statuses, media, emojis, follows and everything else it has are deleted. Its login and the
 * reports by and about it are kept. With `tombstone` false, the account is removed too, with its
 * login and reports, so the username and login can be used again. Every instance Verso knows is
 * sent a Delete of the user. Deleting an account again finishes a deletion that stopped part way.
 * Returns whether it wasn't deleted already.
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

        // Every instance is told, since any may have the user's statuses.
        if (deleted) {
            const entity = deleteEntity(tx, accountId, "User", accountId);
            await queueDeliveriesTo(tx, entity, { instanceIds: [], everyInstance: true });
        }

        return { deleted, keys };
    });

    for (const key of keys) await deleteFileIfUnused(ctx, key);

    return deleted;
};

/** The queue of the jobs that delete local accounts for moderators. */
export const accountDeletionQueue = "account-deletions";

const AccountDeletionJob = z.object({ accountId: z.string() });

/** Queues the deletion of the local account `accountId`, with a tombstone, unless it is queued. */
export const queueAccountDeletion = async (ctx: Context, accountId: string): Promise<void> => {
    const payload: z.infer<typeof AccountDeletionJob> = { accountId };
    await enqueue(ctx, {
        queue: accountDeletionQueue,
        payload,
        dedupeKey: `account-deletion:${accountId}`,
    });
};

/** Deletes a local account, keeping a tombstone, as {@link queueAccountDeletion} asked. */
export const accountDeletionHandler: Handler = async (
    ctx: Context,
    job: JobsTable,
): Promise<void> => {
    const payload = AccountDeletionJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't an account deletion job");

    await deleteLocalAccount(ctx, payload.data.accountId, { tombstone: true });
};
