import type { Insertable, Selectable, SelectQueryBuilder } from "kysely";
import { batchesOf } from "../db/batches.ts";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, type Filter, notExcluded } from "../graph/excluded_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { NotificationsTable, NotificationType } from "./tables.ts";

export type NotificationRow = Selectable<NotificationsTable>;

/** Adds the notifications `rows`, a batch at a time. */
export const insertNotifications = async (
    ctx: Context,
    rows: readonly Insertable<NotificationsTable>[],
): Promise<void> => {
    for (const batch of batchesOf(rows)) {
        await ctx.db.insertInto("notifications").values(batch).execute();
    }
};

/**
 * The key of the latest group of `accountId`'s notifications whose keys start with `prefix` and a
 * dash, if there is one. Keys end in an hour count, which has as many digits until 2084, so the
 * latest sorts last.
 */
export const latestGroupKey = async (
    ctx: Context,
    accountId: string,
    prefix: string,
): Promise<string | undefined> =>
    (await ctx.db.selectFrom("notifications").select("group_key")
        .where("account_id", "=", accountId)
        // After the dash comes the hour; `.` sorts just after `-`.
        .where("group_key", ">", `${prefix}-`)
        .where("group_key", "<", `${prefix}.`)
        .orderBy("group_key", "desc")
        .limit(1)
        .executeTakeFirst())?.group_key ?? undefined;

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

/** The accounts notified that `noteId` mentions them, whether their policies filtered it or not. */
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
    /**
     * Whether to include those the user's policy filtered, as they are when listing one account's,
     * as on Mastodon.
     */
    readonly includeFiltered?: boolean;
};

/** A query of the notifications a user is shown, to select from. */
type ShownQuery = SelectQueryBuilder<Database, "notifications", Record<never, never>>;

/**
 * The notifications of `accountId` that `shown` allows: not from the accounts it hides, and about
 * no status, or one they may see.
 */
export const shownQuery = (ctx: Context, accountId: string, shown: Shown): ShownQuery =>
    ctx.db.selectFrom("notifications")
        .where("account_id", "=", accountId)
        .where(notExcluded(shown.hidden, "notifications.from_account_id"))
        .where((eb) =>
            eb.or([
                eb("notifications.note_id", "is", null),
                shown.seen("notifications.note_id")(eb),
            ])
        );

/** The notifications of `accountId` that {@link shownQuery} and `filter` allow. */
export const filtered = (
    ctx: Context,
    accountId: string,
    shown: Shown,
    filter: NotificationFilter,
): SelectQueryBuilder<Database, "notifications", NotificationRow> => {
    let query = shownQuery(ctx, accountId, shown).selectAll();
    if (filter.types) query = query.where("type", "in", filter.types);
    if (filter.excludeTypes?.length) query = query.where("type", "not in", filter.excludeTypes);
    if (filter.fromId !== undefined) query = query.where("from_account_id", "=", filter.fromId);
    if (!filter.includeFiltered && filter.fromId === undefined) {
        query = query.where("filtered", "=", false);
    }

    return query;
};

/**
 * A page of the notifications of `accountId`, newest first, as {@link shownQuery} and `filter`
 * allow.
 */
export const notificationPage = async (
    ctx: Context,
    accountId: string,
    shown: Shown,
    filter: NotificationFilter,
    page: PageBounds,
): Promise<NotificationRow[]> => {
    if (filter.types?.length === 0) return [];
    return await readPage(filtered(ctx, accountId, shown, filter), "notifications.id", page);
};

/**
 * How many of the notifications of `accountId` that {@link shownQuery} and `filter` allow are newer
 * than `after`, if given, counting up to `limit`.
 */
export const countNotifications = async (
    ctx: Context,
    accountId: string,
    shown: Shown,
    filter: NotificationFilter,
    after: string | undefined,
    limit: number,
): Promise<number> => {
    if (filter.types?.length === 0) return 0;

    let query = filtered(ctx, accountId, shown, filter);
    if (after !== undefined) query = query.where("notifications.id", ">", after);

    const { count } = await ctx.db.selectFrom(query.limit(limit).as("counted"))
        .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
        .executeTakeFirstOrThrow();
    return Number(count);
};

/** The notification `id` of `accountId`, if {@link shownQuery} allows it. */
export const findNotification = async (
    ctx: Context,
    accountId: string,
    id: string,
    shown: Shown,
): Promise<NotificationRow | undefined> =>
    await shownQuery(ctx, accountId, shown).selectAll().where("id", "=", id).executeTakeFirst();

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

/** Of `accountIds`, those notified that `noteId` mentions them, whose policies didn't filter it. */
export const mentionedAmong = async (
    ctx: Context,
    noteId: string,
    accountIds: readonly string[],
): Promise<Set<string>> =>
    new Set(
        accountIds.length === 0
            ? []
            : (await ctx.db.selectFrom("notifications").select("account_id")
                .where("type", "=", "mention")
                .where("note_id", "=", noteId)
                .where("filtered", "=", false)
                .where("account_id", "in", accountIds)
                .execute())
                .map((row) => row.account_id),
    );
