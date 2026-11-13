import { getLogger } from "@logtape/logtape";
import { getUsername } from "../accounts/account_queries.ts";
import { provision } from "../accounts/provision.ts";
import type { Context } from "../kernel/context.ts";
import { getApp } from "./app_queries.ts";
import type { Expired } from "./authorize.ts";
import {
    deleteFlow,
    deleteUnfinishedFlow,
    findFlow,
    findFormFlow,
    markLoggedIn,
    setCode,
} from "./flow_queries.ts";
import type { Scope } from "../kernel/scopes.ts";
import { randomToken } from "./secrets.ts";
import type { OAuthFlowsTable } from "./tables.ts";
import { webClientId } from "./web_app.ts";

const logger = getLogger(["verso", "auth"]);

/** Mastodon's limit on how long an app has to exchange its code for a token. */
const codeLifetimeMs = 10 * 60_000;

/** Where to redirect the browser, and what to tell the app. */
export type SendBack = {
    readonly result: "send-back";
    readonly redirectUri: string;
    readonly params: Readonly<Record<string, string | undefined>>;
};

const sendBack = (
    flow: OAuthFlowsTable,
    params: Readonly<Record<string, string>>,
): SendBack => ({
    result: "send-back",
    redirectUri: flow.redirect_uri,
    params: { ...params, state: flow.state ?? undefined },
});

const denied = (flow: OAuthFlowsTable, description: string) =>
    sendBack(flow, { error: "access_denied", error_description: description });

/**
 * Tells the app the login was denied, and deletes its flow, which can't be finished now. If another
 * request finished the login in the meantime, the flow is left to it, and this response only says
 * the login is over.
 */
const loginDenied = async (ctx: Context, flow: OAuthFlowsTable, description: string) =>
    await deleteUnfinishedFlow(ctx, flow.id)
        ? denied(flow, description)
        : { result: "expired" as const };

/**
 * Gives the app a code to exchange for a token, valid for `codeLifetimeMs`. Only its hash is
 * stored. If the flow already has a code, its form was sent twice at once, and only the first
 * counts.
 */
const issueCode = async (
    ctx: Context,
    flow: OAuthFlowsTable,
): Promise<Expired | SendBack> => {
    const code = randomToken();
    const expiresAt = new Date(ctx.clock.now().getTime() + codeLifetimeMs);

    return await setCode(ctx, flow.id, code, expiresAt)
        ? sendBack(flow, { code })
        : { result: "expired" };
};

/**
 * Finishes the login when the issuer sends the browser back. On success the user is asked to allow
 * the app, except for Verso's own web app, which gets its code straight away. If the login failed,
 * or the issuer's policy won't let the user register, the app is told the user was denied.
 */
export const finishLogin = async (
    ctx: Context,
    browserSecret: string | undefined,
    callback: URL,
): Promise<Expired | { readonly result: "consent" } | SendBack> => {
    const flow = await findFlow(ctx, browserSecret);
    const provider = flow?.issuer ? ctx.identityProviders[flow.issuer] : undefined;
    if (!flow?.login || !provider || flow.account_id !== null) return { result: "expired" };

    let claims;
    try {
        claims = await provider.completeLogin(callback, flow.login);
    } catch (error) {
        logger.warn("A login at {issuer} failed: {error}", { issuer: flow.issuer, error });
        return await loginDenied(ctx, flow, "The login didn't complete.");
    }

    const account = await provision(ctx, provider.issuer, claims);
    if (!account.ok) {
        return await loginDenied(ctx, flow, "This server doesn't take new users from that login.");
    }

    await markLoggedIn(ctx, flow.id, account.accountId);

    const app = await getApp(ctx, flow.app_id);
    return app.client_id === webClientId ? await issueCode(ctx, flow) : { result: "consent" };
};

export type ConsentRequest = {
    readonly appName: string;
    readonly username: string;
    readonly scopes: Scope[];
    readonly formToken: string;
};

/** What the logged-in user is asked to allow, if their browser has a flow waiting for it. */
export const consentRequest = async (
    ctx: Context,
    browserSecret: string | undefined,
): Promise<ConsentRequest | undefined> => {
    const flow = await findFlow(ctx, browserSecret);
    if (!flow?.account_id || flow.form_token === null || flow.code_hash !== null) return undefined;

    return {
        appName: (await getApp(ctx, flow.app_id)).name,
        username: await getUsername(ctx, flow.account_id),
        scopes: flow.scopes,
        formToken: flow.form_token,
    };
};

/** Records the user's answer. Allowing gives the app a code, and denying ends the flow. */
export const decide = async (
    ctx: Context,
    browserSecret: string | undefined,
    formToken: string,
    allow: boolean,
): Promise<Expired | SendBack> => {
    const flow = await findFormFlow(ctx, browserSecret, formToken);
    if (!flow?.account_id || flow.code_hash !== null) return { result: "expired" };

    if (!allow) {
        await deleteFlow(ctx, flow.id);
        return denied(flow, "The user denied access.");
    }

    return await issueCode(ctx, flow);
};
