import { getLogger } from "@logtape/logtape";
import { getUsername } from "../accounts/accounts.ts";
import { provision } from "../accounts/provision.ts";
import type { Context } from "../kernel/context.ts";
import { getApp } from "./apps.ts";
import { deleteFlow, findFlow, findFormFlow, markLoggedIn, setCode } from "./flows.ts";
import type { Scope } from "./scopes.ts";
import { randomToken } from "./secrets.ts";
import type { OAuthFlowsTable } from "./tables.ts";

const logger = getLogger(["verso", "auth"]);

/** How long an app has to trade its code for a token, as in Mastodon. */
const codeLifetimeMs = 10 * 60_000;

/** Where to send the browser back to, and what to tell the app. */
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

/** Tells the app the login was denied, and forgets its flow, which can't be finished now. */
const loginDenied = async (ctx: Context, flow: OAuthFlowsTable, description: string) => {
    await deleteFlow(ctx, flow.id);
    return denied(flow, description);
};

/**
 * Finishes the login when the issuer sends the browser back. On success the user is asked to
 * allow the app. If the login failed, or the issuer's policy won't let the user register, the app
 * is told the user was denied.
 */
export const finishLogin = async (
    ctx: Context,
    browserSecret: string | undefined,
    callback: URL,
): Promise<{ readonly result: "expired" } | { readonly result: "consent" } | SendBack> => {
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

    return { result: "consent" };
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

/**
 * Records the user's answer. Allowing gives the app a code, valid for ten minutes, to trade for a
 * token; only its hash is kept. Denying ends the flow.
 */
export const decide = async (
    ctx: Context,
    browserSecret: string | undefined,
    formToken: string,
    allow: boolean,
): Promise<{ readonly result: "expired" } | SendBack> => {
    const flow = await findFormFlow(ctx, browserSecret, formToken);
    if (!flow?.account_id || flow.code_hash !== null) return { result: "expired" };

    if (!allow) {
        await deleteFlow(ctx, flow.id);
        return denied(flow, "The user denied access.");
    }

    const code = randomToken();
    const expiresAt = new Date(ctx.clock.now().getTime() + codeLifetimeMs);

    return await setCode(ctx, flow.id, code, expiresAt)
        ? sendBack(flow, { code })
        : { result: "expired" };
};
