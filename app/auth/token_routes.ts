import { OAuthServerMetadata, Token } from "@versia/client-api";
import { z } from "zod";
import { HttpError } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { scopes } from "../kernel/scopes.ts";
import {
    authenticateClient,
    clientCredentialsFrom,
    grantToken,
    type IssuedToken,
    revokeToken,
} from "./tokens.ts";

const tokenOf = (issued: IssuedToken): Token => ({
    access_token: issued.token,
    token_type: "Bearer",
    scope: issued.scopes.join(" "),
    created_at: Math.floor(issued.createdAt.getTime() / 1000),
});

/**
 * Issues a token to an app. Errors are in OAuth's shape, as RFC 6749 requires.
 * @see https://docs.joinmastodon.org/methods/oauth/#token
 */
const postToken = defineRoute({
    method: "POST",
    path: "/oauth/token",
    summary: "Obtain a token",
    description: "Obtain an access token, to be used during API calls that are not public.",
    docs: "https://docs.joinmastodon.org/methods/oauth/#token",
    oauthErrors: true,
    body: z.object({
        grant_type: z.string().optional(),
        client_id: z.string().optional(),
        client_secret: z.string().optional(),
        code: z.string().optional(),
        redirect_uri: z.string().optional(),
        code_verifier: z.string().optional(),
        scope: z.string().optional(),
    }),
    headers: z.object({ authorization: z.string().optional() }),
    responses: { 200: Token },
    handler: async (ctx, { body, headers }) => {
        const credentials = clientCredentialsFrom(headers.authorization, body);
        const app = await authenticateClient(ctx, credentials);
        if (!app) throw new HttpError(401, "invalid_client", "The app's credentials are wrong.");

        const grant = await grantToken(ctx, app, {
            grantType: body.grant_type,
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
            scope: body.scope,
        });
        if ("error" in grant) throw new HttpError(400, grant.error, grant.description);

        return { status: 200, body: tokenOf(grant.issued) };
    },
});

/**
 * Revokes a token, for the app it was issued to. As in Mastodon, the app must always send its
 * credentials, and omitting the token isn't an error.
 * @see https://docs.joinmastodon.org/methods/oauth/#revoke
 */
const postRevoke = defineRoute({
    method: "POST",
    path: "/oauth/revoke",
    summary: "Revoke a token",
    description: "Revoke an access token to make it no longer valid for use.",
    docs: "https://docs.joinmastodon.org/methods/oauth/#revoke",
    oauthErrors: true,
    body: z.object({
        client_id: z.string().optional(),
        client_secret: z.string().optional(),
        token: z.string().optional(),
    }),
    headers: z.object({ authorization: z.string().optional() }),
    responses: { 200: z.strictObject({}) },
    handler: async (ctx, { body, headers }) => {
        const app = await authenticateClient(
            ctx,
            clientCredentialsFrom(headers.authorization, body),
        );
        const allowed = app !== undefined &&
            (body.token === undefined || await revokeToken(ctx, app, body.token));

        if (!allowed) {
            throw new HttpError(
                403,
                "unauthorized_client",
                "You are not authorized to revoke this token",
            );
        }

        return { status: 200, body: {} };
    },
});

/**
 * For clients that discover the OAuth endpoints instead of assuming Mastodon's paths.
 * @see https://docs.joinmastodon.org/methods/oauth/#authorization-server-metadata
 */
const getOAuthMetadata = defineRoute({
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    summary: "Discover OAuth Server Configuration",
    description: "Returns the OAuth 2 Authorization Server Metadata for the Mastodon server, " +
        "as defined by RFC 8414.",
    docs: "https://docs.joinmastodon.org/methods/oauth/#authorization-server-metadata",
    responses: { 200: OAuthServerMetadata },
    handler: ({ urls }) =>
        Promise.resolve({
            status: 200,
            body: {
                issuer: urls.origin,
                authorization_endpoint: urls.url`/oauth/authorize`,
                token_endpoint: urls.url`/oauth/token`,
                revocation_endpoint: urls.url`/oauth/revoke`,
                app_registration_endpoint: urls.url`/api/v1/apps`,
                scopes_supported: [...scopes],
                response_types_supported: ["code"],
                response_modes_supported: ["query"],
                grant_types_supported: ["authorization_code", "client_credentials"],
                token_endpoint_auth_methods_supported: [
                    "client_secret_basic",
                    "client_secret_post",
                ],
                code_challenge_methods_supported: ["S256"],
            },
        }),
});

/** The endpoints apps call directly for tokens. */
export const tokenRoutes: readonly Route[] = [postToken, postRevoke, getOAuthMetadata];
