import { z } from "zod";
import { defineRoute, Page, Redirect, type Route } from "../http/route.ts";
import { authorize, chooseIssuer, outOfBand, withParams } from "./authorize.ts";
import { consentRequest, decide, finishLogin, type SendBack } from "./consent.ts";
import { chooserPage, codePage, consentPage, errorPage } from "./pages.ts";

const expired = {
    status: 400,
    page: errorPage("This login has expired. Go back to the app to try again."),
} as const;

const unreachable = (issuer: string) => ({
    status: 502,
    page: errorPage(`Can't reach ${issuer} right now. Try again in a moment.`),
} as const);

/**
 * Sends the browser back to the app with a code or an error. An out-of-band app has nowhere to
 * send it, so the user is shown the code to copy, or the error.
 */
const replyToApp = ({ redirectUri, params }: Omit<SendBack, "result">) => {
    if (redirectUri !== outOfBand) {
        return { status: 302, location: withParams(redirectUri, params) } as const;
    }

    return params.code === undefined
        ? { status: 400, page: errorPage(params.error_description ?? "") } as const
        : { status: 200, page: codePage(params.code) } as const;
};

/** The cookie that ties a login to the browser that started it. */
const FlowCookie = z.object({ oauth_flow: z.string().optional() });

/**
 * Refuses forms posted from other origins, which the form token already stops. Sibling subdomains
 * count as the same site, so SameSite cookies don't. Browsers too old to send it are let through.
 */
const SameOrigin = z.object({ "sec-fetch-site": z.literal("same-origin").optional() });

const getAuthorize = defineRoute({
    method: "GET",
    path: "/oauth/authorize",
    summary: "Starts logging a user in to an app",
    query: z.object({
        client_id: z.string().optional(),
        redirect_uri: z.string().optional(),
        response_type: z.string().optional(),
        scope: z.string().optional(),
        state: z.string().optional(),
        code_challenge: z.string().optional(),
        code_challenge_method: z.string().optional(),
    }),
    responses: { 200: Page, 302: Redirect, 400: Page, 502: Page },
    handler: async (ctx, { query }) => {
        const authorization = await authorize(ctx, query);

        switch (authorization.result) {
            case "unreachable":
                return unreachable(authorization.issuer);

            case "refused":
                return { status: 400, page: errorPage(authorization.description) };

            case "error":
                return replyToApp(authorization);

            case "choose":
                return {
                    status: 200,
                    page: chooserPage(authorization.issuers, authorization.formToken),
                    cookies: { oauth_flow: authorization.browserSecret },
                };

            case "login":
                return {
                    status: 302,
                    location: authorization.url.href,
                    cookies: { oauth_flow: authorization.browserSecret },
                };
        }
    },
});

const postIssuer = defineRoute({
    method: "POST",
    path: "/oauth/authorize/issuer",
    summary: "Logs in with the issuer the user chose",
    body: z.object({ issuer: z.string(), form_token: z.string() }),
    cookies: FlowCookie,
    headers: SameOrigin,
    responses: { 303: Redirect, 400: Page, 502: Page },
    handler: async (ctx, { body, cookies }) => {
        const login = await chooseIssuer(ctx, cookies.oauth_flow, body.form_token, body.issuer);

        switch (login.result) {
            case "expired":
                return expired;
            case "unreachable":
                return unreachable(login.issuer);
            case "login":
                return { status: 303, location: login.url.href };
        }
    },
});

const getCallback = defineRoute({
    method: "GET",
    path: "/oauth/callback",
    summary: "Finishes the login when the issuer sends the user back",
    query: z.record(z.string(), z.string()),
    cookies: FlowCookie,
    responses: { 200: Page, 302: Redirect, 303: Redirect, 400: Page },
    handler: async (ctx, { query, cookies }) => {
        const callback = new URL(withParams(ctx.urls.url`/oauth/callback`, query));
        const login = await finishLogin(ctx, cookies.oauth_flow, callback);

        // A redirect, so reloading the consent page doesn't send the issuer's code again.
        if (login.result === "consent") {
            return { status: 303, location: ctx.urls.url`/oauth/consent` };
        }

        return login.result === "expired" ? expired : replyToApp(login);
    },
});

const getConsent = defineRoute({
    method: "GET",
    path: "/oauth/consent",
    summary: "Asks the user whether to let the app use their account",
    cookies: FlowCookie,
    responses: { 200: Page, 400: Page },
    handler: async (ctx, { cookies }) => {
        const request = await consentRequest(ctx, cookies.oauth_flow);

        return request ? { status: 200, page: consentPage(request) } : expired;
    },
});

const postConsent = defineRoute({
    method: "POST",
    path: "/oauth/consent",
    summary: "Records whether the user lets the app use their account",
    body: z.object({ decision: z.enum(["allow", "deny"]), form_token: z.string() }),
    cookies: FlowCookie,
    headers: SameOrigin,
    responses: { 200: Page, 302: Redirect, 400: Page },
    handler: async (ctx, { body, cookies }) => {
        const allow = body.decision === "allow";
        const decision = await decide(ctx, cookies.oauth_flow, body.form_token, allow);
        if (decision.result === "expired") return expired;

        return { ...replyToApp(decision), cookies: { oauth_flow: null } };
    },
});

/** The pages a user goes through in the browser to log in to an app. */
export const loginRoutes: readonly Route[] = [
    getAuthorize,
    postIssuer,
    getCallback,
    getConsent,
    postConsent,
];
