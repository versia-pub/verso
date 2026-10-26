import type { Context } from "../kernel/context.ts";
import type { DomainBlocksTable } from "./tables.ts";
import type { Selectable } from "kysely";

export type DomainBlock = Selectable<DomainBlocksTable>;

/** The blocks created with `blockDomain`, by domain. */
export const listBlockedDomains = (ctx: Context): Promise<DomainBlock[]> =>
    ctx.db.selectFrom("domain_blocks").selectAll().orderBy("domain").execute();

/** The domains that admins blocked, which are few. */
export const blockedDomainNames = async (ctx: Context): Promise<ReadonlySet<string>> =>
    new Set(
        (await ctx.db.selectFrom("domain_blocks").select("domain").execute())
            .map((row) => row.domain),
    );

/** Adds a block of `domain`, unless there is one. Returns whether it was added. */
export const insertDomainBlock = async (
    ctx: Context,
    domain: string,
    reason: string,
): Promise<boolean> =>
    await ctx.db.insertInto("domain_blocks")
        .values({ domain, reason, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.doNothing())
        .returning("domain")
        .executeTakeFirst() !== undefined;

/** Removes the block of `domain`. Returns whether there was one. */
export const deleteDomainBlock = async (ctx: Context, domain: string): Promise<boolean> =>
    await ctx.db.deleteFrom("domain_blocks")
        .where("domain", "=", domain)
        .returning("domain")
        .executeTakeFirst() !== undefined;
