import type { Context } from "../kernel/context.ts";
import type { Scope } from "./scopes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import type { AppsTable } from "./tables.ts";

export type ClientCredentials = { readonly clientId: string; readonly clientSecret: string };

/**
 * The client's credentials from HTTP Basic or, without that, from the form, in the order Doorkeeper
 * reads them. In Basic, RFC 6749 form-encodes each part first, but client ids and secrets are
 * base64url, which that leaves as it is.
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1
 */
export const clientCredentialsFrom = (
    authorization: string | undefined,
    form: { readonly client_id?: string; readonly client_secret?: string },
): ClientCredentials | undefined => {
    const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "")?.[1];

    if (basic === undefined) {
        return form.client_id === undefined || form.client_secret === undefined
            ? undefined
            : { clientId: form.client_id, clientSecret: form.client_secret };
    }

    try {
        const pair = new TextDecoder().decode(Uint8Array.fromBase64(basic));
        const colon = pair.indexOf(":");
        if (colon === -1) return undefined;

        return { clientId: pair.slice(0, colon), clientSecret: pair.slice(colon + 1) };
    } catch {
        return undefined;
    }
};

/** The app these credentials belong to, if they're right. */
export const authenticateClient = async (
    ctx: Context,
    credentials: ClientCredentials | undefined,
): Promise<AppsTable | undefined> => {
    if (!credentials) return undefined;

    const app = await ctx.db.selectFrom("apps")
        .selectAll()
        .where("client_id", "=", credentials.clientId)
        .executeTakeFirst();

    return app?.client_secret_hash === await hashToken(credentials.clientSecret) ? app : undefined;
};

export type IssuedToken = {
    readonly token: string;
    readonly scopes: Scope[];
    readonly createdAt: Date;
};

/** Makes a token for `app` to act for an account, or for itself if `accountId` is `null`. */
export const issueToken = async (
    ctx: Context,
    app: AppsTable,
    accountId: string | null,
    scopes: Scope[],
): Promise<IssuedToken> => {
    const token = randomToken();
    const createdAt = ctx.clock.now();

    await ctx.db.insertInto("access_tokens")
        .values({
            id: ctx.ids(),
            token_hash: await hashToken(token),
            app_id: app.id,
            account_id: accountId,
            scopes,
            created_at: createdAt,
        })
        .execute();

    return { token, scopes, createdAt };
};
