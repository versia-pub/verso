/**
 * Notifications as the client API renders them.
 * @module
 */
import type {
    GroupedNotificationsResults,
    Notification,
    NotificationGroup,
    PartialAccountWithAvatar,
} from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccountsOf } from "../accounts/public.ts";
import { notificationsHiddenFrom } from "../graph/hidden.ts";
import { emojisOfReactions } from "../interactions/reaction_render_queries.ts";
import { renderReactionEmoji } from "../interactions/render.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import { isSeenBy } from "../notes/thread_queries.ts";
import { onlookerOf } from "../notes/visibility.ts";
import { groupKeyOf, groupStatsOf } from "./group_queries.ts";
import { findNotification, type NotificationRow, type Shown } from "./notification_queries.ts";
import type { NotificationType } from "./tables.ts";

/**
 * Which of a local user's notifications they are shown: none from the accounts they block, by
 * domain too, or mute with their notifications, and none about statuses they may no longer see.
 * Those are kept, so that unblocking or unmuting shows them again.
 */
export const shownOf = (ctx: Context, accountId: string): Shown => ({
    hidden: notificationsHiddenFrom(ctx, accountId),
    seen: (column) => isSeenBy(ctx, onlookerOf(ctx, accountId), column),
});

/** The notification `id` of `accountId`, if they are shown it, as {@link shownOf} decides. */
export const shownNotification = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<Notification | undefined> => {
    const row = await findNotification(ctx, accountId, id, shownOf(ctx, accountId));
    return row && (await renderNotifications(ctx, [row], accountId))[0];
};

/**
 * The notifications `rows` of `viewerId`, in order, with the accounts that caused them and the
 * statuses they are about, as the viewer sees those, which they must be able to see, as
 * {@link shownOf} ensures. Those of types that aren't grouped each have a group of their own.
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

/** The parts of an account that {@link PartialAccountWithAvatar} has. */
const partialAccount = (
    { id, acct, url, avatar, avatar_static, locked, bot }: PartialAccountWithAvatar,
): PartialAccountWithAvatar => ({ id, acct, url, avatar, avatar_static, locked, bot });

/**
 * The notification groups `rows`, a page of them as `notificationGroupPage` finds them, of
 * `viewerId`, in order, with the accounts that caused their notifications and the statuses they
 * are about. With `partial`, only each group's newest account is in full, and the others in part,
 * as Mastodon's `partial_avatars`. Without `paged`, they are whole groups rather than a page, so
 * have no page's ids.
 * @see https://github.com/mastodon/mastodon/blob/v4.3.0/app/models/notification_group.rb
 */
export const renderNotificationGroups = async (
    ctx: Context,
    rows: readonly NotificationRow[],
    grouped: readonly NotificationType[],
    viewerId: string,
    options: { readonly partial: boolean; readonly paged: boolean },
): Promise<GroupedNotificationsResults> => {
    const { partial, paged } = options;
    const newest = rows.at(0);
    const oldest = rows.at(-1);
    if (newest === undefined || oldest === undefined) {
        return { accounts: [], statuses: [], notification_groups: [] };
    }

    const keyed = rows.map((row) => ({ row, key: groupKeyOf(row, grouped) }));
    const stats = await groupStatsOf(
        ctx,
        viewerId,
        shownOf(ctx, viewerId),
        keyed.map(({ key }) => key),
        { oldest: oldest.id, newest: newest.id },
    );

    // A notification on its own is its group's only one.
    const groups = keyed.map(({ row, key }) => {
        const group = stats.get(key);
        return {
            row,
            key,
            count: group?.count ?? 1,
            pageMinId: group?.pageMinId ?? row.id,
            samples: group?.samples ?? [row],
            reactionIds: group?.reactionIds ?? (row.reaction_id === null ? [] : [row.reaction_id]),
        };
    });

    const fromIds = [
        ...new Set(groups.flatMap((group) => group.samples.map((s) => s.from_account_id))),
    ];
    const accounts = await publicAccountsOf(ctx, await findAccounts(ctx, fromIds));

    const noteIds = [...new Set(rows.flatMap((row) => row.note_id ?? []))];
    const notes = await renderStatuses(ctx, await findNotes(ctx, noteIds), viewerId);
    const statuses = new Map(notes.map((status) => [status.id, status]));

    const reactions = await emojisOfReactions(ctx, groups.flatMap((group) => group.reactionIds));

    const notificationGroups = groups.flatMap((group): NotificationGroup[] => {
        // Notifications are deleted with their accounts, so every sample has one.
        const latest = group.samples.at(0);
        if (latest === undefined) return [];

        const status = group.row.note_id === null ? undefined : statuses.get(group.row.note_id);
        const emojis = new Map(group.reactionIds.flatMap((id) => {
            const reaction = reactions.get(id);
            if (reaction === undefined) return [];

            const emoji = renderReactionEmoji(ctx, reaction);
            return [[emoji.emoji, emoji]];
        }));

        return [{
            group_key: group.key,
            notifications_count: group.count,
            type: group.row.type,
            most_recent_notification_id: latest.id,
            ...(paged && {
                page_min_id: group.pageMinId,
                page_max_id: latest.id,
                latest_page_notification_at: latest.created_at.toISOString(),
            }),
            sample_account_ids: group.samples.map((sample) => sample.from_account_id),
            ...(status && { status_id: status.id }),
            ...(group.row.type === "reaction" && { emojis: [...emojis.values()] }),
        }];
    });

    const sampled = notificationGroups.map((group) => group.sample_account_ids);
    const full = new Set(sampled.flatMap((ids) => partial ? ids.slice(0, 1) : ids));
    const rest = new Set(sampled.flatMap((ids) => ids).filter((id) => !full.has(id)));
    const accountsOf = (ids: ReadonlySet<string>) =>
        [...ids].flatMap((id) => accounts.get(id) ?? []);

    return {
        accounts: accountsOf(full),
        ...(partial && { partial_accounts: accountsOf(rest).map(partialAccount) }),
        statuses: [...new Set(notificationGroups.flatMap((group) => group.status_id ?? []))]
            .flatMap((id) => statuses.get(id) ?? []),
        notification_groups: notificationGroups,
    };
};
