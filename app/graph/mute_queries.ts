import type { ExpressionBuilder, Selectable } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountIdQuery } from "./follow_queries.ts";
import type { MutesTable } from "./tables.ts";

export type MuteRow = Selectable<MutesTable>;

/** How an account mutes another. */
export type MuteOptions = {
    readonly notifications: boolean;
    /** `null` for a mute that doesn't end. */
    readonly expiresAt: Date | null;
};

/** Whether a mute is still active at `now`. */
const ongoing = (now: Date) => (eb: ExpressionBuilder<Database, "mutes">) =>
    eb.or([eb("mutes.expires_at", "is", null), eb("mutes.expires_at", ">", now)]);

/** Adds a mute, or changes how the account already mutes the target. */
export const upsertMute = async (
    ctx: Context,
    accountId: string,
    targetId: string,
    options: MuteOptions,
): Promise<void> => {
    await ctx.db.insertInto("mutes")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            target_id: targetId,
            notifications: options.notifications,
            expires_at: options.expiresAt,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) =>
            conflict.columns(["account_id", "target_id"]).doUpdateSet({
                notifications: options.notifications,
                expires_at: options.expiresAt,
            })
        )
        .execute();
};

/** Removes a mute. Returns whether there was one still active. */
export const deleteMute = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<boolean> => {
    const removed = await ctx.db.deleteFrom("mutes")
        .where("account_id", "=", accountId)
        .where("target_id", "=", targetId)
        .returning("expires_at")
        .executeTakeFirst();

    return removed !== undefined &&
        (removed.expires_at === null || removed.expires_at > ctx.clock.now());
};

/** How `accountId` mutes each of `otherIds` that it mutes, by the muted account. */
export const mutesOf = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Map<string, MuteRow>> => {
    if (otherIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("mutes").selectAll()
        .where("account_id", "=", accountId)
        .where("target_id", "in", otherIds)
        .where(ongoing(ctx.clock.now()))
        .execute();
    return new Map(rows.map((row) => [row.target_id, row]));
};

/**
 * A page of the accounts `accountId` mutes, latest muted first, each as the mute's id, which pages
 * are counted by, the muted account's id, and when the mute ends.
 */
export const mutePage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; account_id: string; expires_at: Date | null }[]> =>
    await readPage(
        ctx.db.selectFrom("mutes")
            .select(["id", "target_id as account_id", "expires_at"])
            .where("account_id", "=", accountId)
            .where(ongoing(ctx.clock.now())),
        "mutes.id",
        page,
    );

/** The accounts `accountId` currently mutes, as a subquery. */
export const mutedIdsQuery = (ctx: Context, accountId: string): AccountIdQuery =>
    ctx.db.selectFrom("mutes")
        .select("target_id as account_id")
        .where("account_id", "=", accountId)
        .where(ongoing(ctx.clock.now()));
