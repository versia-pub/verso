import type { Insertable, Selectable } from "kysely";
import { batchesOf } from "../db/batches.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, type Filter, notExcluded } from "../graph/excluded_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { NotificationsTable, NotificationType } from "./tables.ts";

export type NotificationRow = Selectable<NotificationsTable>;

export const insertNotifications = async (
    ctx: Context,
    rows: readonly Insertable<NotificationsTable>[],
): Promise<void> => {
    for (const batch of batchesOf(rows)) {
        await ctx.db.insertInto("notifications").values(batch).execute();
    }
};

/** Deletes the notifications of the follow `followId`. Returns whether there were any. */
export const deleteFollowNotifications = async (
    ctx: Context,
    followId: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("notifications")
        .where("follow_id", "=", followId)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/** The accounts notified that `noteId` mentions them. */
export const mentionNotifiedIds = async (ctx: Context, noteId: string): Promise<Set<string>> =>
    new Set(
        (await ctx.db.selectFrom("notifications").select("account_id")
            .where("type", "=", "mention")
            .where("note_id", "=", noteId)
            .execute())
            .map((row) => row.account_id),
    );

/** Which of a user's notifications are shown to them. */
export type Shown = {
    /** The accounts whose notifications are hidden. */
    readonly hidden: Excluded;
    /** Whether the user may see the status whose id is in a column. */
    readonly seen: (column: string) => Filter;
};

/** Which notifications to list, besides those {@link Shown} omits. */
export type NotificationFilter = {
    /** Only these types, if given. */
    readonly types?: readonly NotificationType[];
    readonly excludeTypes?: readonly NotificationType[];
    /** Only those from this account, if given. */
    readonly fromId?: string;
};

/**
 * The notifications of `accountId` that `shown` allows: not from the accounts it hides, and about
 * no status, or one they may see.
 */
const shownTo = (ctx: Context, accountId: string, shown: Shown) =>
    ctx.db.selectFrom("notifications").selectAll()
        .where("account_id", "=", accountId)
        .where(notExcluded(shown.hidden, "notifications.from_account_id"))
        .where((eb) =>
            eb.or([
                eb("notifications.note_id", "is", null),
                shown.seen("notifications.note_id")(eb),
            ])
        );

/**
 * A page of the notifications of `accountId`, newest first, as {@link shownTo} and `filter` allow.
 */
export const notificationPage = async (
    ctx: Context,
    accountId: string,
    shown: Shown,
    filter: NotificationFilter,
    page: PageBounds,
): Promise<NotificationRow[]> => {
    if (filter.types?.length === 0) return [];

    let query = shownTo(ctx, accountId, shown);
    if (filter.types) query = query.where("type", "in", filter.types);
    if (filter.excludeTypes?.length) query = query.where("type", "not in", filter.excludeTypes);
    if (filter.fromId !== undefined) query = query.where("from_account_id", "=", filter.fromId);

    return await readPage(query, "notifications.id", page);
};

/** The notification `id` of `accountId`, if {@link shownTo} allows it. */
export const findNotification = async (
    ctx: Context,
    accountId: string,
    id: string,
    shown: Shown,
): Promise<NotificationRow | undefined> =>
    await shownTo(ctx, accountId, shown).where("id", "=", id).executeTakeFirst();

/** Deletes the notification `id` of `accountId`. Returns whether there was one. */
export const deleteNotification = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("notifications")
        .where("account_id", "=", accountId)
        .where("id", "=", id)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/** Deletes every notification of `accountId`. */
export const deleteNotificationsOf = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.deleteFrom("notifications").where("account_id", "=", accountId).execute();
};
