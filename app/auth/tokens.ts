import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import type { Viewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { type Channel, publish, subscribe } from "../kernel/pubsub.ts";
import type { Scope } from "../kernel/scopes.ts";
import { findAppByClientId } from "./app_queries.ts";
import { deleteFlow, setCodeToken, useCode } from "./flow_queries.ts";
import { requestedScopes } from "../kernel/scopes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import {
    deleteToken,
    findTokenByHash,
    insertToken,
    tokenIdsOf,
    tokenUsable,
} from "./token_queries.ts";
import type { AppsTable } from "./tables.ts";

const logger = getLogger(["verso", "auth"]);

/** Says a token was revoked, so every process stops serving what it opened, like streams. */
const revoked: Channel<{ readonly tokenId: string }> = {
    name: "tokens.revoked",
    schema: z.object({ tokenId: z.string() }),
};

/** Revokes a token, telling every process once the current transaction commits. */
const revoke = async (ctx: Context, tokenId: string) => {
    await deleteToken(ctx, tokenId);
    await publish(ctx, revoked, { tokenId });
};

/**
 * Tells every process to stop serving what the tokens of `accountId` opened, as if they were
 * revoked, though they are kept. The message goes out once the current transaction commits. Run it
 * once the user is suspended, so the tokens can't be used again.
 */
export const endSessionsOf = async (ctx: Context, accountId: string): Promise<void> => {
    for (const tokenId of await tokenIdsOf(ctx, accountId)) {
        await publish(ctx, revoked, { tokenId });
    }
};

/**
 * Calls `onRevoked` when the token is revoked or its user is suspended, until the returned function
 * is called. It is called at once if that already happened, and may be called more than once. A
 * process that may have missed the message checks that the token can still be used.
 */
export const watchToken = (ctx: Context, tokenId: string, onRevoked: () => void): () => void => {
    let watching = true;
    // Not once stopped, even if a check was still running.
    const check = async () => {
        if (!await tokenUsable(ctx, tokenId) && watching) onRevoked();
    };

    const unsubscribe = subscribe(ctx, revoked, (message) => {
        if (message.tokenId === tokenId) onRevoked();
        return Promise.resolve();
    });
    const unwatch = ctx.pubsub.onMissed(check);

    // It may have been revoked before this subscribed.
    check().catch((error) => {
        logger.error("Couldn't check token {tokenId} is still issued: {error}", { tokenId, error });
    });

    return () => {
        watching = false;
        unsubscribe();
        unwatch();
    };
};

/** A token this server issued, found by its hash, since that's all that is stored. */
const findToken = async (ctx: Context, token: string) =>
    await findTokenByHash(ctx, await hashToken(token));

/** The viewer an access token stands for, if it's a token this server issued. */
export const authenticateToken = async (
    ctx: Context,
    token: string,
): Promise<Viewer | undefined> => {
    const row = await findToken(ctx, token);

    return row && {
        tokenId: row.id,
        appId: row.app_id,
        accountId: row.account_id,
        scopes: row.scopes,
        suspended: row.suspended_at !== null,
        moved: row.moved_to_account_id !== null,
    };
};

/** A client's id, and its secret, which a public client doesn't have. */
export type ClientCredentials = {
    readonly clientId: string;
    readonly clientSecret: string | undefined;
};

/**
 * The client's credentials from HTTP Basic or, without it, from the form, in the order Doorkeeper
 * reads them. RFC 6749 form-encodes each part in Basic, but client ids and secrets are base64url,
 * which that encoding leaves unchanged. A public client sends only its id, in the form.
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1
 */
export const clientCredentialsFrom = (
    authorization: string | undefined,
    form: { readonly client_id?: string; readonly client_secret?: string },
): ClientCredentials | undefined => {
    const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "")?.[1];

    if (basic === undefined) {
        return form.client_id === undefined
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

/**
 * The app these credentials belong to, if they're valid: a confidential client's secret must
 * match, and a public client must send none.
 */
export const authenticateClient = async (
    ctx: Context,
    credentials: ClientCredentials | undefined,
): Promise<AppsTable | undefined> => {
    if (!credentials) return undefined;

    const app = await findAppByClientId(ctx, credentials.clientId);
    if (!app) return undefined;

    const { clientSecret } = credentials;
    const valid = app.client_secret_hash === null
        ? clientSecret === undefined
        : clientSecret !== undefined && app.client_secret_hash === await hashToken(clientSecret);

    return valid ? app : undefined;
};

export type IssuedToken = {
    /** Its id in `access_tokens`. */
    readonly id: string;
    readonly token: string;
    readonly scopes: Scope[];
    readonly createdAt: Date;
};

/** Issues a token for `app` to act for an account, or for itself if `accountId` is `null`. */
export const issueToken = async (
    ctx: Context,
    app: AppsTable,
    accountId: string | null,
    scopes: Scope[],
): Promise<IssuedToken> => {
    const token = randomToken();
    const createdAt = ctx.clock.now();

    const id = await insertToken(ctx, {
        hash: await hashToken(token),
        appId: app.id,
        accountId,
        scopes,
        createdAt,
    });

    return { id, token, scopes, createdAt };
};

/** A PKCE code verifier: 43 to 128 of these characters. */
const codeVerifier = /^[A-Za-z0-9._~-]{43,128}$/;

/** What an app sends to exchange a code for a token. */
export type CodeExchange = {
    readonly code: string;
    readonly redirectUri: string | undefined;
    readonly codeVerifier: string | undefined;
};

/**
 * Whether the verifier matches the flow's S256 challenge: its SHA-256 in base64url, like
 * `hashToken`. Without a challenge, a verifier is rejected rather than ignored, so an attacker
 * can't strip the challenge from the user's request.
 * @see https://www.rfc-editor.org/rfc/rfc9700#section-2.1.1
 */
const pkceMatches = async (challenge: string | null, verifier: string | undefined) =>
    challenge === null
        ? verifier === undefined
        : verifier !== undefined && codeVerifier.test(verifier) &&
            await hashToken(verifier) === challenge;

/**
 * Exchanges a code for a token to act for the user who allowed it, with the scopes they allowed.
 * The code must be for this app and redirect URI, unexpired, and pass PKCE, which a public client
 * must use. It can only be tried once, so a failed attempt uses it up too. Trying it again revokes
 * the token it issued, since someone else may have it.
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2
 */
export const exchangeCode = (
    ctx: Context,
    app: AppsTable,
    exchange: CodeExchange,
): Promise<IssuedToken | undefined> =>
    ctx.transaction(async (tx) => {
        const used = await useCode(tx, exchange.code);
        if (!used) return undefined;

        const { flow } = used;
        if (used.reused) {
            if (flow.token_id !== null) await revoke(tx, flow.token_id);
            await deleteFlow(tx, flow.id);
            return undefined;
        }

        const valid = flow.account_id && flow.app_id === app.id &&
            flow.redirect_uri === exchange.redirectUri &&
            (app.client_secret_hash !== null || flow.code_challenge !== null) &&
            await pkceMatches(flow.code_challenge, exchange.codeVerifier);
        if (!valid) return undefined;

        const issued = await issueToken(tx, app, flow.account_id, flow.scopes);
        await setCodeToken(tx, flow.id, issued.id);
        return issued;
    });

/** What an app sends to `/oauth/token`, besides its credentials. */
export type TokenRequest = {
    readonly grantType: string | undefined;
    readonly code: string | undefined;
    readonly redirectUri: string | undefined;
    readonly codeVerifier: string | undefined;
    readonly scope: string | undefined;
};

/** Why a token wasn't granted, as an OAuth error code and its description. */
export type GrantRefused = {
    readonly error:
        | "invalid_request"
        | "invalid_grant"
        | "invalid_scope"
        | "unauthorized_client"
        | "unsupported_grant_type";
    readonly description: string;
};

/**
 * A token for the grant the app requested: a code the user allowed, or the app's own credentials.
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.2
 */
export const grantToken = async (
    ctx: Context,
    app: AppsTable,
    request: TokenRequest,
): Promise<{ readonly issued: IssuedToken } | GrantRefused> => {
    switch (request.grantType) {
        case undefined:
            return { error: "invalid_request", description: "The grant type is missing." };

        // Mastodon ignores `scope` here: the token gets the scopes the user allowed.
        case "authorization_code": {
            if (request.code === undefined) {
                return { error: "invalid_request", description: "The code is missing." };
            }

            const issued = await exchangeCode(ctx, app, { ...request, code: request.code });
            return issued ? { issued } : {
                error: "invalid_grant",
                description: "The code is wrong, used, expired or another app's, or PKCE failed.",
            };
        }

        // Only for confidential clients, since anyone can send a public client's id.
        // https://www.rfc-editor.org/rfc/rfc6749#section-4.4
        case "client_credentials": {
            if (app.client_secret_hash === null) {
                return {
                    error: "unauthorized_client",
                    description: "A public app can't get a token for itself.",
                };
            }

            const scopes = requestedScopes(request.scope, app.scopes);
            return scopes ? { issued: await issueToken(ctx, app, null, scopes) } : {
                error: "invalid_scope",
                description: "The app didn't register all of these scopes.",
            };
        }

        default:
            return {
                error: "unsupported_grant_type",
                description: "That grant type isn't supported.",
            };
    }
};

/**
 * Revokes a token, if `app` may: only the app it was issued to can. Returns whether it may. A token
 * that doesn't exist, or no longer does, counts as revoked, so that succeeds.
 * @see https://www.rfc-editor.org/rfc/rfc7009#section-2.2
 */
export const revokeToken = async (
    ctx: Context,
    app: AppsTable,
    token: string,
): Promise<boolean> => {
    const row = await findToken(ctx, token);
    if (!row) return true;
    if (row.app_id !== app.id) return false;

    await revoke(ctx, row.id);
    return true;
};
