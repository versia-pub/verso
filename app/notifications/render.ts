/**
 * Notifications as the client API renders them.
 * @module
 */
import type { Notification } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccountsOf } from "../accounts/public.ts";
import { notificationsHiddenFrom } from "../graph/hidden.ts";
import { emojisOfReactions } from "../interactions/reaction_queries.ts";
import { renderReactionEmoji } from "../interactions/render.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import { isSeenBy } from "../notes/thread_queries.ts";
import { onlookerOf } from "../notes/visibility.ts";
import type { NotificationRow, Shown } from "./notification_queries.ts";

/**
 * Which of a local user's notifications they are shown: none from the accounts they block, by
 * domain too, or mute with their notifications, and none about statuses they may no longer see.
 * Those are kept, so that unblocking or unmuting shows them again.
 */
export const shownTo = (ctx: Context, accountId: string): Shown => ({
    hidden: notificationsHiddenFrom(ctx, accountId),
    seen: (column) => isSeenBy(ctx, onlookerOf(ctx, accountId), column),
});

/**
 * The notifications `rows` of `viewerId`, in order, with the accounts that caused them and the
 * statuses they are about, as the viewer sees those, which they must be able to see, as
 * {@link shownTo} ensures. Those of types that aren't grouped each have a group of their own.
 */
export const renderNotifications = async (
    ctx: Context,
    rows: readonly NotificationRow[],
    viewerId: string,
): Promise<Notification[]> => {
    const fromIds = [...new Set(rows.map((row) => row.from_account_id))];
    const accounts = await publicAccountsOf(ctx, await findAccounts(ctx, fromIds));

    const noteIds = [...new Set(rows.flatMap((row) => row.note_id ?? []))];
    const notes = await renderStatuses(ctx, await findNotes(ctx, noteIds), viewerId);
    const statuses = new Map(notes.map((status) => [status.id, status]));

    const reactions = await emojisOfReactions(ctx, rows.flatMap((row) => row.reaction_id ?? []));

    return rows.flatMap((row): Notification[] => {
        const account = accounts.get(row.from_account_id);
        const status = row.note_id === null ? undefined : statuses.get(row.note_id);
        const reaction = row.reaction_id === null ? undefined : reactions.get(row.reaction_id);
        if (account === undefined) return [];

        return [{
            id: row.id,
            type: row.type,
            group_key: row.group_key ?? `ungrouped-${row.id}`,
            created_at: row.created_at.toISOString(),
            account,
            ...(status && { status }),
            ...(reaction && renderReactionEmoji(ctx, reaction)),
        }];
    });
};
