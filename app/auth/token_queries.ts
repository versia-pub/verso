import type { Context } from "../kernel/context.ts";
import type { Scope } from "../kernel/scopes.ts";
import type { AccessTokensTable } from "./tables.ts";

/** The token with this hash, which is all that is kept of it. */
export const findTokenByHash = async (
    ctx: Context,
    hash: string,
): Promise<AccessTokensTable | undefined> =>
    await ctx.db.selectFrom("access_tokens")
        .selectAll()
        .where("token_hash", "=", hash)
        .executeTakeFirst();

/** Keeps a new token, by its hash. */
export const insertToken = async (
    ctx: Context,
    token: {
        readonly hash: string;
        readonly appId: string;
        readonly accountId: string | null;
        readonly scopes: Scope[];
        readonly createdAt: Date;
    },
): Promise<void> => {
    await ctx.db.insertInto("access_tokens")
        .values({
            id: ctx.ids(),
            token_hash: token.hash,
            app_id: token.appId,
            account_id: token.accountId,
            scopes: token.scopes,
            created_at: token.createdAt,
        })
        .execute();
};

/** Deletes a token, which revokes it. */
export const deleteToken = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("access_tokens").where("id", "=", id).execute();
};
