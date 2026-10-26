import { getLogger } from "@logtape/logtape";
import type { Context } from "../kernel/context.ts";
import type { IdentityProvider, Issuer } from "../kernel/identity.ts";
import { findAppByClientId } from "./app_queries.ts";
import { createFlow, findFormFlow, recordLogin } from "./flow_queries.ts";
import { requestedScopes, type Scope } from "../kernel/scopes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import type { AppsTable, OAuthFlowsTable } from "./tables.ts";

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
export type IssuerUnreachable = { readonly result: "unreachable"; readonly issuer: string };

export type Authorization =
    | IssuerUnreachable
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
        readonly formToken: string;
        readonly issuers: Issuer[];
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

/** An app's request to log a user in, once checked, or what to answer it with. */
type Checked =
    | {
        readonly ok: true;
        readonly app: AppsTable;
        readonly redirectUri: string;
        readonly scopes: Scope[];
        readonly challenge: string | undefined;
    }
    | { readonly ok: false; readonly answer: Authorization };

/**
 * Checks an app's request to log a user in. Errors before the redirect URI is known can't go back
 * to the app, so they are shown to the user instead.
 */
const checkRequest = async (ctx: Context, request: AuthorizeRequest): Promise<Checked> => {
    const refused = (description: string): Checked => ({
        ok: false,
        answer: { result: "refused", description },
    });

    const app = await findAppByClientId(ctx, request.client_id);
    if (!app) return refused("The app isn't registered here.");

    const redirectUri = request.redirect_uri;
    if (redirectUri === undefined || !app.redirect_uris.includes(redirectUri)) {
        return refused("The app sent a redirect URI it didn't register.");
    }

    const error = (error: string, description: string): Checked => ({
        ok: false,
        answer: {
            result: "error",
            redirectUri,
            params: { error, error_description: description, state: request.state },
        },
    });

    if (request.response_type === undefined) {
        return error("invalid_request", "The response type is missing.");
    }

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

    return { ok: true, app, redirectUri, scopes, challenge };
};

/**
 * Checks an app's request to log a user in, and starts the flow. The flow is tied to the browser
 * by `browserSecret`, which goes in a cookie, so another browser can't finish it.
 */
export const authorize = async (
    ctx: Context,
    request: AuthorizeRequest,
): Promise<Authorization> => {
    const checked = await checkRequest(ctx, request);
    if (!checked.ok) return checked.answer;

    const { app, redirectUri, scopes, challenge } = checked;
    const providers = Object.values(ctx.identityProviders);
    if (providers.length === 0) {
        return { result: "refused", description: "Logging in isn't set up on this server." };
    }

    const only = providers.length === 1 ? providers[0] : undefined;
    const login = only && await beginLogin(ctx, only);
    if (only && !login) return { result: "unreachable", issuer: only.issuer.name };

    const browserSecret = randomToken();
    const formToken = randomToken();

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
        form_token: formToken,
        code_hash: null,
        code_used_at: null,
        token_id: null,
        expires_at: new Date(ctx.clock.now().getTime() + flowLifetimeMs),
        created_at: ctx.clock.now(),
    };

    await createFlow(ctx, flow);

    return login ? { result: "login", browserSecret, url: login.url } : {
        result: "choose",
        browserSecret,
        formToken,
        issuers: providers.map((p) => p.issuer),
    };
};

/**
 * Starts the login at the issuer the user chose, if the browser has a flow waiting for a login and
 * the issuer is configured.
 */
export const chooseIssuer = async (
    ctx: Context,
    browserSecret: string | undefined,
    formToken: string,
    issuerUrl: string,
): Promise<
    { readonly result: "expired" } | IssuerUnreachable | {
        readonly result: "login";
        readonly url: URL;
    }
> => {
    const provider = Object.hasOwn(ctx.identityProviders, issuerUrl)
        ? ctx.identityProviders[issuerUrl]
        : undefined;
    const flow = await findFormFlow(ctx, browserSecret, formToken);
    if (!provider || !flow || flow.account_id !== null) return { result: "expired" };

    const login = await beginLogin(ctx, provider);
    if (!login) return { result: "unreachable", issuer: provider.issuer.name };

    await recordLogin(ctx, flow.id, issuerUrl, login.flow);

    return { result: "login", url: login.url };
};
