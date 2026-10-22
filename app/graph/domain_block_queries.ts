import { type ExpressionBuilder, sql } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountIdQuery } from "./follow_queries.ts";

/** Adds a domain block, unless the account already blocks the domain. */
export const insertDomainBlock = async (
    ctx: Context,
    accountId: string,
    domain: string,
): Promise<void> => {
    await ctx.db.insertInto("account_domain_blocks")
        .values({ id: ctx.ids(), account_id: accountId, domain, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.columns(["account_id", "domain"]).doNothing())
        .execute();
};

/** Removes a domain block. Returns whether there was one. */
export const deleteDomainBlock = async (
    ctx: Context,
    accountId: string,
    domain: string,
): Promise<boolean> =>
    (await ctx.db.deleteFrom("account_domain_blocks")
        .where("account_id", "=", accountId)
        .where("domain", "=", domain)
        .returning("id")
        .executeTakeFirst()) !== undefined;

/**
 * A page of the domains `accountId` blocks, the latest blocked first, each with the block's id,
 * which pages are counted by.
 */
export const domainBlockPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<{ id: string; domain: string }[]> =>
    await readPage(
        ctx.db.selectFrom("account_domain_blocks")
            .select(["id", "domain"])
            .where("account_id", "=", accountId),
        "account_domain_blocks.id",
        page,
    );

/** An account joined with its instance. */
type OnInstance = ExpressionBuilder<Database, "accounts" | "instances">;

/** Whether `accountId` blocks the joined instance's domain, or one it is under. */
const blocksInstance = (accountId: string) => (eb: OnInstance) =>
    eb.exists(
        eb.selectFrom("account_domain_blocks")
            .select("account_domain_blocks.id")
            .where("account_domain_blocks.account_id", "=", accountId)
            .where((inner) =>
                inner.or([
                    inner("account_domain_blocks.domain", "=", inner.ref("instances.domain")),
                    inner(
                        "instances.domain",
                        "like",
                        sql<string>`'%.' || ${inner.ref("account_domain_blocks.domain")}`,
                    ),
                ])
            ),
    );

/** The accounts on the domains `accountId` blocks, and on their subdomains, as a subquery. */
export const domainBlockedIdsQuery = (ctx: Context, accountId: string): AccountIdQuery =>
    ctx.db.selectFrom("accounts")
        .innerJoin("instances", "instances.id", "accounts.instance_id")
        .select("accounts.id as account_id")
        .where(blocksInstance(accountId));

/** Which of `otherIds` are on domains `accountId` blocks, or their subdomains. */
export const domainBlockedAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<Set<string>> => {
    if (otherIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("accounts")
        .innerJoin("instances", "instances.id", "accounts.instance_id")
        .select("accounts.id")
        .where("accounts.id", "in", otherIds)
        .where(blocksInstance(accountId))
        .execute();

    return new Set(rows.map((row) => row.id));
};
