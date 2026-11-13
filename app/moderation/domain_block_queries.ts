import type { Context } from "../kernel/context.ts";
import type { DomainBlocksTable } from "./tables.ts";
import type { Selectable } from "kysely";

export type DomainBlock = Selectable<DomainBlocksTable>;

/** What a block notes besides its domain. */
export type DomainBlockNotes = {
    /** Why the domain is blocked, which the public list may show. Empty if none. */
    readonly reason?: string;
    /** Why the domain is blocked, for moderators only. */
    readonly privateComment?: string | null;
    /** Whether the public list masks the domain. */
    readonly obfuscate?: boolean;
};

/** The blocks created with `blockDomain`, by domain. */
export const listBlockedDomains = (ctx: Context): Promise<DomainBlock[]> =>
    ctx.db.selectFrom("domain_blocks").selectAll().orderBy("domain").execute();

/** The block with this id. */
export const findDomainBlock = (ctx: Context, id: string): Promise<DomainBlock | undefined> =>
    ctx.db.selectFrom("domain_blocks").selectAll().where("id", "=", id).executeTakeFirst();

/** The domains that admins blocked, which are few. */
export const blockedDomainNames = async (ctx: Context): Promise<ReadonlySet<string>> =>
    new Set(
        (await ctx.db.selectFrom("domain_blocks").select("domain").execute())
            .map((row) => row.domain),
    );

/** Adds a block of `domain`, unless there is one. Returns it if it was added. */
export const insertDomainBlock = (
    ctx: Context,
    domain: string,
    notes: DomainBlockNotes,
): Promise<DomainBlock | undefined> =>
    ctx.db.insertInto("domain_blocks")
        .values({
            id: ctx.ids(),
            domain,
            reason: notes.reason ?? "",
            private_comment: notes.privateComment ?? null,
            obfuscate: notes.obfuscate ?? false,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.column("domain").doNothing())
        .returningAll()
        .executeTakeFirst();

/** Changes what the block with this id notes. Returns it if there is one. */
export const updateDomainBlock = (
    ctx: Context,
    id: string,
    notes: DomainBlockNotes,
): Promise<DomainBlock | undefined> =>
    ctx.db.updateTable("domain_blocks")
        .set({
            reason: notes.reason,
            private_comment: notes.privateComment,
            obfuscate: notes.obfuscate,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

/** Removes the block of `domain`. Returns whether there was one. */
export const deleteDomainBlock = async (ctx: Context, domain: string): Promise<boolean> =>
    await ctx.db.deleteFrom("domain_blocks")
        .where("domain", "=", domain)
        .returning("domain")
        .executeTakeFirst() !== undefined;

/** The block of exactly `domain`. */
export const findDomainBlockOf = (
    ctx: Context,
    domain: string,
): Promise<DomainBlock | undefined> =>
    ctx.db.selectFrom("domain_blocks").selectAll().where("domain", "=", domain).executeTakeFirst();
