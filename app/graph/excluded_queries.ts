import { type Expression, type ExpressionBuilder, sql, type SqlBool } from "kysely";
import type { SelectQueryBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountIdQuery } from "./follow_queries.ts";

/** Instance ids, as a subquery. */
export type InstanceIdQuery = SelectQueryBuilder<Database, keyof Database, { instance_id: string }>;

/**
 * Accounts excluded from what reaches someone: the ones they block (or mute, too), and every
 * account on the instances whose domains they block. Those are matched by each account's instance,
 * so that a domain with many accounts on it makes no long list.
 */
export type Excluded = {
    readonly accounts: AccountIdQuery;
    /** Whether the account whose id is in `column` is on one of the instances. */
    readonly onInstances: (column: string) => Expression<unknown>;
    /**
     * The accounts, and those on the instances, as one list, for finding what they did from them,
     * through indexes that start from an account, rather than looking up each row's account. An
     * account can be in it twice, which `in` doesn't mind.
     */
    readonly all: AccountIdQuery;
};

/**
 * The accounts `accounts`, and those on the instances `instances`. It reads the `accounts` table
 * directly rather than going through its module, so that it takes one query.
 */
export const excluded = (
    ctx: Context,
    accounts: AccountIdQuery,
    instances: InstanceIdQuery,
): Excluded => ({
    accounts,
    onInstances: (column) =>
        ctx.db.selectFrom("accounts as excluded").select("excluded.id")
            .where("excluded.id", "=", sql.ref<string>(column))
            .where("excluded.instance_id", "in", instances),
    all: accounts.unionAll(
        ctx.db.selectFrom("accounts as excluded").select("excluded.id as account_id")
            .where("excluded.instance_id", "in", instances),
    ),
});

/** A condition on rows, for any query's `where`. */
export type Filter = <DB, TB extends keyof DB>(
    eb: ExpressionBuilder<DB, TB>,
) => Expression<SqlBool>;

/** Whether the account whose id is in `column`, such as `likes.account_id`, is among `excluded`. */
export const isExcluded =
    (excluded: Excluded, column: string): Filter =>
    <DB, TB extends keyof DB>(eb: ExpressionBuilder<DB, TB>): Expression<SqlBool> =>
        eb.or([
            eb(sql.ref<string>(column), "in", excluded.accounts),
            eb.exists(excluded.onInstances(column)),
        ]);

/** Whether the account whose id is in `column` isn't among `excluded`. */
export const notExcluded =
    (excluded: Excluded, column: string): Filter =>
    <DB, TB extends keyof DB>(eb: ExpressionBuilder<DB, TB>): Expression<SqlBool> =>
        eb.not(isExcluded(excluded, column)(eb));
