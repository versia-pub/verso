import { type ExpressionBuilder, sql } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { InstanceIdQuery } from "./excluded_queries.ts";

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
 * A page of the domains `accountId` blocks, latest blocked first, each with the block's id, which
 * pages are counted by.
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

/** Whether the domain block is of the instance's domain, or a domain it is under. */
const blocksDomainOf = (eb: ExpressionBuilder<Database, "account_domain_blocks" | "instances">) =>
    eb.or([
        eb("account_domain_blocks.domain", "=", eb.ref("instances.domain")),
        eb(
            "instances.domain",
            "like",
            sql<string>`'%.' || ${eb.ref("account_domain_blocks.domain")}`,
        ),
    ]);

/** Whether `accountId` blocks the instance's domain, or a domain it is under. */
const blocksInstance = (accountId: string) => (eb: ExpressionBuilder<Database, "instances">) =>
    eb.exists(
        eb.selectFrom("account_domain_blocks")
            .select("account_domain_blocks.id")
            .where("account_domain_blocks.account_id", "=", accountId)
            .where(blocksDomainOf),
    );

/**
 * The instances on the domains `accountId` blocks, and on their subdomains, as a subquery. They are
 * far fewer than the accounts on them. It reads the `instances` table directly rather than going
 * through its module, so that it takes one query.
 */
export const domainBlockedInstancesQuery = (ctx: Context, accountId: string): InstanceIdQuery =>
    ctx.db.selectFrom("instances")
        .select("instances.id as instance_id")
        .where(blocksInstance(accountId));

/**
 * Which of `otherIds` are on domains `accountId` blocks, or their subdomains. It reads the
 * `accounts` and `instances` tables directly rather than going through their modules, so that it
 * takes one query.
 */
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

/**
 * Which of `otherIds`, of which there must be some, block the domain `accountId` is on, or a domain
 * it is under. It reads the `accounts` and `instances` tables directly rather than going through
 * their modules, so that it takes one query.
 */
export const domainBlockersAmong = async (
    ctx: Context,
    accountId: string,
    otherIds: readonly string[],
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("accounts")
        .innerJoin("instances", "instances.id", "accounts.instance_id")
        .innerJoin("account_domain_blocks", (join) => join.on(blocksDomainOf))
        .select("account_domain_blocks.account_id")
        .where("accounts.id", "=", accountId)
        .where("account_domain_blocks.account_id", "in", otherIds)
        .execute();
    return rows.map((row) => row.account_id);
};
