import type { Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { NotificationRequestsTable } from "./tables.ts";

export type NotificationRequestRow = Selectable<NotificationRequestsTable>;

/** A page of `accountId`'s requests, the newest first. */
export const requestPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<NotificationRequestRow[]> =>
    await readPage(
        ctx.db.selectFrom("notification_requests").selectAll().where("account_id", "=", accountId),
        "notification_requests.id",
        page,
    );

/** Those of `ids` that are `accountId`'s requests. */
export const findRequests = async (
    ctx: Context,
    accountId: string,
    ids: readonly string[],
): Promise<NotificationRequestRow[]> =>
    ids.length === 0 ? [] : await ctx.db.selectFrom("notification_requests").selectAll()
        .where("account_id", "=", accountId)
        .where("id", "in", ids)
        .execute();

/** Deletes `request`. */
export const deleteRequest = async (
    ctx: Context,
    request: NotificationRequestRow,
): Promise<void> => {
    await ctx.db.deleteFrom("notification_requests").where("id", "=", request.id).execute();
};

/** Lets `fromId`'s notifications of `accountId` through their policy. */
export const permitNotifications = async (
    ctx: Context,
    accountId: string,
    fromId: string,
): Promise<void> => {
    await ctx.db.insertInto("notification_permissions")
        .values({ account_id: accountId, from_account_id: fromId, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
};

/** Of `accountIds`, those who let `fromId`'s notifications through their policies. */
export const permittingAmong = async (
    ctx: Context,
    fromId: string,
    accountIds: readonly string[],
): Promise<Set<string>> =>
    new Set(
        accountIds.length === 0
            ? []
            : (await ctx.db.selectFrom("notification_permissions").select("account_id")
                .where("from_account_id", "=", fromId)
                .where("account_id", "in", accountIds)
                .execute())
                .map((row) => row.account_id),
    );

/**
 * Stops filtering `fromId`'s filtered notifications of `accountId`. Returns the statuses of the
 * mentions among them.
 */
export const unfilterNotifications = async (
    ctx: Context,
    accountId: string,
    fromId: string,
): Promise<string[]> =>
    (await ctx.db.updateTable("notifications")
        .set({ filtered: false })
        .where("account_id", "=", accountId)
        .where("from_account_id", "=", fromId)
        .where("filtered", "=", true)
        .returning(["type", "note_id"])
        .execute())
        .flatMap((row) => row.type === "mention" && row.note_id !== null ? [row.note_id] : []);

/** Deletes `fromId`'s filtered notifications of `accountId`. */
export const deleteFilteredNotifications = async (
    ctx: Context,
    accountId: string,
    fromId: string,
): Promise<void> => {
    await ctx.db.deleteFrom("notifications")
        .where("account_id", "=", accountId)
        .where("from_account_id", "=", fromId)
        .where("filtered", "=", true)
        .execute();
};
