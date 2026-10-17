import type { AliasedAggregateFunctionBuilder, ExpressionBuilder } from "kysely";

/** A count of the rows a query finds, to select as `count`, then read with `readCount`. */
export const countAll = <DB, TB extends keyof DB>(
    eb: ExpressionBuilder<DB, TB>,
): AliasedAggregateFunctionBuilder<DB, TB, number | string | bigint, "count"> =>
    eb.fn.countAll<number | string | bigint>().as("count");

/** The count `countAll` selected. Drivers give it as a number, a string or a bigint. */
export const readCount = (row: { readonly count: number | string | bigint }): number =>
    Number(row.count);
