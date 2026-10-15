import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import type { IdentityProvider } from "./identity.ts";
import { requestedScopes } from "./scopes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import type { OAuthFlowsTable } from "./tables.ts";

const logger = getLogger(["verso", "auth"]);

/** How long a user has to log in and allow the app. */
const flowLifetimeMs = 30 * 60_000;

/** Mastodon's redirect URI for apps that show the user the code, instead of receiving it. */
export const outOfBand = "urn:ietf:wg:oauth:2.0:oob";

/** An S256 PKCE challenge: a SHA-256 hash in base64url. */
const s256Challenge = /^[A-Za-z0-9_-]{43}$/;

/**
 * The query of `/oauth/authorize`.
 * @see https://docs.joinmastodon.org/methods/oauth/#authorize
 */
export type AuthorizeRequest = {
    readonly client_id?: string;
    readonly redirect_uri?: string;
    readonly response_type?: string;
    readonly scope?: string;
    readonly state?: string;
    readonly code_challenge?: string;
    readonly code_challenge_method?: string;
};

/** The issuer, by name, couldn't be reached to start the login. */
export type Unreachable = { readonly result: "unreachable"; readonly issuer: string };

export type Authorization =
    | Unreachable
    /** The app or its redirect URI is wrong, so the user is told instead of redirected. */
    | { readonly result: "refused"; readonly description: string }
    /** An OAuth error, to send back to the app's redirect URI. */
    | {
        readonly result: "error";
        readonly redirectUri: string;
        readonly params: Readonly<Record<string, string | undefined>>;
    }
    /** The user picks one of several issuers. */
    | {
        readonly result: "choose";
        readonly browserSecret: string;
        readonly issuers: IdentityProvider["issuer"][];
    }
    /** The browser goes to the only issuer to log in. */
    | { readonly result: "login"; readonly browserSecret: string; readonly url: URL };

/** Starts a login at the issuer, or returns nothing if it can't be reached. */
const beginLogin = async (ctx: Context, provider: IdentityProvider) => {
    try {
        return await provider.beginLogin(ctx.urls.url`/oauth/callback`);
    } catch (error) {
        const issuer = provider.issuer.url;
        logger.warn("Can't start a login at {issuer}: {error}", { issuer, error });
        return undefined;
    }
};

/** `uri` with `params` added to its query, leaving out undefined ones. */
export const withParams = (
    uri: string,
    params: Readonly<Record<string, string | undefined>>,
): string => {
    const url = new URL(uri);

    for (const [name, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(name, value);
    }

    return url.href;
};

const findApp = (ctx: Context, clientId: string | undefined) =>
    clientId === undefined
        ? undefined
        : ctx.db.selectFrom("apps").selectAll().where("client_id", "=", clientId)
            .executeTakeFirst();

/**
 * Checks an app's request to log a user in, and starts the flow. The flow is tied to the browser
 * by `browserSecret`, which goes in a cookie, so another browser can't finish it.
 */
export const authorize = async (
    ctx: Context,
    request: AuthorizeRequest,
): Promise<Authorization> => {
    const app = await findApp(ctx, request.client_id);
    if (!app) return { result: "refused", description: "The app isn't registered here." };

    const redirectUri = request.redirect_uri;
    if (redirectUri === undefined || !app.redirect_uris.includes(redirectUri)) {
        return {
            result: "refused",
            description: "The app sent a redirect URI it didn't register.",
        };
    }

    const error = (error: string, description: string): Authorization => ({
        result: "error",
        redirectUri,
        params: { error, error_description: description, state: request.state },
    });

    if (request.response_type !== "code") {
        return error("unsupported_response_type", "Only the code flow is supported.");
    }

    const scopes = requestedScopes(request.scope, app.scopes);
    if (!scopes) {
        return error("invalid_scope", "The app didn't register all of these scopes.");
    }

    const challenge = request.code_challenge;
    if (
        challenge !== undefined &&
        (request.code_challenge_method !== "S256" || !s256Challenge.test(challenge))
    ) {
        return error("invalid_request", "PKCE must use S256.");
    }

    const providers = Object.values(ctx.identityProviders);
    if (providers.length === 0) {
        return { result: "refused", description: "Logging in isn't set up on this server." };
    }

    const only = providers.length === 1 ? providers[0] : undefined;
    const login = only && await beginLogin(ctx, only);
    if (only && !login) return { result: "unreachable", issuer: only.issuer.name };

    const browserSecret = randomToken();

    const flow: OAuthFlowsTable = {
        id: await hashToken(browserSecret),
        app_id: app.id,
        redirect_uri: redirectUri,
        scopes,
        state: request.state ?? null,
        code_challenge: challenge ?? null,
        issuer: only?.issuer.url ?? null,
        login: login?.flow ?? null,
        account_id: null,
        code_hash: null,
        expires_at: new Date(ctx.clock.now().getTime() + flowLifetimeMs),
        created_at: ctx.clock.now(),
    };

    await ctx.db.insertInto("oauth_flows").values(flow).execute();

    return login
        ? { result: "login", browserSecret, url: login.url }
        : { result: "choose", browserSecret, issuers: providers.map((p) => p.issuer) };
};

/** Deletes flows past their expiry: logins never finished, and codes never traded for tokens. */
export const deleteExpiredFlows = async (ctx: Context): Promise<void> => {
    await ctx.db.deleteFrom("oauth_flows").where("expires_at", "<=", ctx.clock.now()).execute();
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
 * Starts the login at the issuer the user chose, if the browser has a flow waiting for a login and
 * the issuer is configured.
 */
export const chooseIssuer = async (
    ctx: Context,
    browserSecret: string | undefined,
    issuerUrl: string,
): Promise<
    { readonly result: "expired" } | Unreachable | { readonly result: "login"; readonly url: URL }
> => {
    const provider = Object.hasOwn(ctx.identityProviders, issuerUrl)
        ? ctx.identityProviders[issuerUrl]
        : undefined;
    const flow = await findFlow(ctx, browserSecret);
    if (!provider || !flow || flow.account_id !== null) return { result: "expired" };

    const login = await beginLogin(ctx, provider);
    if (!login) return { result: "unreachable", issuer: provider.issuer.name };

    await ctx.db.updateTable("oauth_flows")
        .set({ issuer: issuerUrl, login: login.flow })
        .where("id", "=", flow.id)
        .execute();

    return { result: "login", url: login.url };
};
