/**
 * Every query on the `oauth_flows` table, so its rules are kept in one place.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import type { LoginFlow } from "../kernel/identity.ts";
import { hashToken } from "./secrets.ts";
import type { OAuthFlowsTable } from "./tables.ts";

export const createFlow = async (ctx: Context, flow: OAuthFlowsTable): Promise<void> => {
    await ctx.db.insertInto("oauth_flows").values(flow).execute();
};

/** The unexpired flow tied to a browser by its cookie, if there is one. */
export const findFlow = async (
    ctx: Context,
    browserSecret: string | undefined,
): Promise<OAuthFlowsTable | undefined> =>
    browserSecret === undefined ? undefined : await ctx.db.selectFrom("oauth_flows")
        .selectAll()
        .where("id", "=", await hashToken(browserSecret))
        .where("expires_at", ">", ctx.clock.now())
        .executeTakeFirst();

/**
 * The flow a form the user sent was for, if it is still the browser's flow. Another login started
 * in the browser since replaces the cookie, so a form left open from before is refused.
 */
export const findFormFlow = async (
    ctx: Context,
    browserSecret: string | undefined,
    formToken: string,
): Promise<OAuthFlowsTable | undefined> => {
    const flow = await findFlow(ctx, browserSecret);
    return flow?.form_token === formToken ? flow : undefined;
};

/** Records the issuer the user chose, and the login started there. */
export const recordLogin = async (
    ctx: Context,
    flowId: string,
    issuer: string,
    login: LoginFlow,
): Promise<void> => {
    await ctx.db.updateTable("oauth_flows")
        .set({ issuer, login })
        .where("id", "=", flowId)
        .execute();
};

/** Records who logged in. */
export const markLoggedIn = async (
    ctx: Context,
    flowId: string,
    accountId: string,
): Promise<void> => {
    await ctx.db.updateTable("oauth_flows")
        .set({ account_id: accountId })
        .where("id", "=", flowId)
        .execute();
};

/**
 * Gives the flow its code, keeping only the hash, and a new expiry. Returns false if it already
 * had one, so when the form is sent twice at once, only the first answer counts.
 */
export const setCode = async (
    ctx: Context,
    flowId: string,
    code: string,
    expiresAt: Date,
): Promise<boolean> => {
    const { numUpdatedRows } = await ctx.db.updateTable("oauth_flows")
        .set({ code_hash: await hashToken(code), expires_at: expiresAt })
        .where("id", "=", flowId)
        .where("code_hash", "is", null)
        .executeTakeFirstOrThrow();

    return numUpdatedRows > 0n;
};

/**
 * Uses up the unexpired flow with this code, and returns it, or the flow it was already used for,
 * saying so. Marking it used first means a code can only be tried once, even by two requests at
 * once.
 */
export const useCode = async (
    ctx: Context,
    code: string,
): Promise<{ readonly flow: OAuthFlowsTable; readonly reused: boolean } | undefined> => {
    const hash = await hashToken(code);
    const now = ctx.clock.now();

    const unused = await ctx.db.updateTable("oauth_flows")
        .set({ code_used_at: now })
        .where("code_hash", "=", hash)
        .where("expires_at", ">", now)
        .where("code_used_at", "is", null)
        .returningAll()
        .executeTakeFirst();
    if (unused) return { flow: unused, reused: false };

    // Expired or not, as long as it is kept.
    const used = await ctx.db.selectFrom("oauth_flows").selectAll()
        .where("code_hash", "=", hash)
        .executeTakeFirst();
    return used && { flow: used, reused: true };
};

/** Notes the token a flow's code was traded for. */
export const setCodeToken = async (
    ctx: Context,
    flowId: string,
    tokenId: string,
): Promise<void> => {
    await ctx.db.updateTable("oauth_flows").set({ token_id: tokenId }).where("id", "=", flowId)
        .execute();
};

/**
 * Deletes a flow whose login hasn't finished. Returns false if it has, as when the browser came
 * back twice at once and the other time logged in, so the flow stays for it.
 */
export const deleteUnfinishedFlow = async (ctx: Context, flowId: string): Promise<boolean> => {
    const deleted = await ctx.db.deleteFrom("oauth_flows")
        .where("id", "=", flowId)
        .where("account_id", "is", null)
        .returning("id")
        .executeTakeFirst();

    return deleted !== undefined;
};

export const deleteFlow = async (ctx: Context, flowId: string): Promise<void> => {
    await ctx.db.deleteFrom("oauth_flows").where("id", "=", flowId).execute();
};

/** Deletes flows past their expiry: logins never finished, and codes traded or never traded. */
export const deleteExpiredFlows = async (ctx: Context): Promise<void> => {
    await ctx.db.deleteFrom("oauth_flows").where("expires_at", "<=", ctx.clock.now()).execute();
};
