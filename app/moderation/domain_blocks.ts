/**
 * Instances Verso doesn't federate with: it drops what they send and sends them nothing. Blocking
 * a domain blocks its subdomains too, so a blocked operator can't get around it with new ones.
 * @module
 */
import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { DomainBlocksTable } from "./tables.ts";

export type DomainBlock = Selectable<DomainBlocksTable>;

/** `domain` and the domains it is under, such as `b.example` and `example` for `a.b.example`. */
const domainAndParents = (domain: string) =>
    domain.split(".").map((_, index, labels) => labels.slice(index).join("."));

/**
 * Blocks a domain, saying why, unless it is already. Returns whether it wasn't; one that was keeps
 * its reason.
 */
export const blockDomain = async (
    ctx: Context,
    domain: string,
    reason = "",
): Promise<boolean> => {
    const inserted = await ctx.db.insertInto("domain_blocks")
        .values({ domain, reason, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.doNothing())
        .returning("domain")
        .executeTakeFirst();

    return inserted !== undefined;
};

/** Unblocks a domain blocked with `blockDomain`. Returns whether it was. */
export const unblockDomain = async (ctx: Context, domain: string): Promise<boolean> => {
    const deleted = await ctx.db.deleteFrom("domain_blocks")
        .where("domain", "=", domain)
        .returning("domain")
        .executeTakeFirst();

    return deleted !== undefined;
};

/** The blocks made with `blockDomain`, by domain. */
export const listBlockedDomains = (ctx: Context): Promise<DomainBlock[]> =>
    ctx.db.selectFrom("domain_blocks").selectAll().orderBy("domain").execute();

/** Whether an instance is blocked, by config or by an admin. */
export type IsBlocked = (ctx: Context, domain: string) => Promise<boolean>;

/** Checks domains against the ones config blocks, and the ones admins blocked. */
export const domainBlocks = (configured: readonly string[]): IsBlocked => {
    const fromConfig = new Set(configured);

    return async (ctx, domain) => {
        const domains = domainAndParents(domain.toLowerCase());
        if (domains.some((candidate) => fromConfig.has(candidate))) return true;

        const blocked = await ctx.db.selectFrom("domain_blocks")
            .select("domain")
            .where("domain", "in", domains)
            .executeTakeFirst();

        return blocked !== undefined;
    };
};
