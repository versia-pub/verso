import type { Context } from "../kernel/context.ts";
import type { Permission } from "../kernel/permissions.ts";
import type { Scope } from "../kernel/scopes.ts";
import type { StreamViewer } from "./dispatcher.ts";

/** A viewer, with a token with `scopes`, who has `permissions`. */
export const viewerOf = (
    accountId: string,
    permissions: readonly Permission[],
    scopes: readonly Scope[] = ["read"],
): StreamViewer => ({
    tokenId: "token",
    appId: "app",
    accountId,
    scopes,
    forgetPermissions: () => {},
    permissions: () => Promise.resolve(new Set<Permission>(permissions)),
});

/** `ctx`, but with a database that counts the queries made with it, and how many there were. */
export const countingContext = (ctx: Context): { ctx: Context; queries: () => number } => {
    let queries = 0;
    const db = ctx.db.withPlugin({
        transformQuery: ({ node }) => node,
        transformResult: ({ result }) => {
            queries += 1;
            return Promise.resolve(result);
        },
    });

    return { ctx: { ...ctx, db }, queries: () => queries };
};
