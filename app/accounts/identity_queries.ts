/**
 * The logins at identity providers linked to local accounts.
 * @module
 */
import type { Context } from "../kernel/context.ts";

/** The account a login at `issuer` as `subject` is linked to, if any. */
export const linkedAccount = async (
    ctx: Context,
    issuer: string,
    subject: string,
): Promise<string | undefined> => {
    const row = await ctx.db.selectFrom("identities")
        .select("account_id")
        .where("issuer", "=", issuer)
        .where("subject", "=", subject)
        .executeTakeFirst();

    return row?.account_id;
};

/**
 * Links a login to an account. Returns whether it did, which it doesn't if it was linked already.
 */
export const linkIdentity = async (
    ctx: Context,
    identity: { readonly issuer: string; readonly subject: string; readonly accountId: string },
): Promise<boolean> => {
    const linked = await ctx.db.insertInto("identities")
        .values({
            issuer: identity.issuer,
            subject: identity.subject,
            account_id: identity.accountId,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("account_id")
        .executeTakeFirst();

    return linked !== undefined;
};
