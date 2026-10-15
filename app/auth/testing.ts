import type { Context } from "../kernel/context.ts";
import { registerApp } from "./apps.ts";
import type { Scope } from "./scopes.ts";
import { issueToken } from "./tokens.ts";

/**
 * An access token, for tests that skip logging in: for the account, or for an app itself with
 * `null`. It has the scopes a usual client asks for, unless others are given.
 */
export const tokenFor = async (
    ctx: Context,
    accountId: string | null,
    scopes: Scope[] = ["read", "write", "follow", "push"],
): Promise<string> => {
    const { app } = await registerApp(ctx, {
        name: "Test app",
        website: null,
        redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
        scopes,
    });

    return (await issueToken(ctx, app, accountId, scopes)).token;
};
