import { type Application, CredentialApplication } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, Page, Redirect, type Route } from "../http/route.ts";
import { registerApp } from "./apps.ts";
import { authorize, chooseIssuer, outOfBand, withParams } from "./authorize.ts";
import { consentRequest, decide, finishLogin, type SendBack } from "./consent.ts";
import { chooserPage, codePage, consentPage, errorPage } from "./pages.ts";
import { ScopeList } from "./scopes.ts";
import type { AppsTable } from "./tables.ts";

const scriptSchemes = ["data:", "javascript:", "vbscript:"];

/**
 * Absolute, such as `https://app.example/callback`, `tusky://oauth` or Mastodon's
 * `urn:ietf:wg:oauth:2.0:oob`, with no fragment. No whitespace either, since `redirect_uri` joins
 * them with newlines.
 */
const RedirectUri = z.string().refine((text) => {
    const url = URL.parse(text);
    return url !== null && !/[\s#]/.test(text) && !scriptSchemes.includes(url.protocol);
}, "Must be an absolute URI without a fragment");

/**
 * Mastodon's parameters and limits.
 * @see https://docs.joinmastodon.org/methods/apps/#create
 */
const AppForm = z.object({
    client_name: z.string().trim().min(1).max(60),
    redirect_uris: z.union([z.string(), z.array(z.string())])
        .transform((uris) => [uris].flat())
        .pipe(z.array(RedirectUri).min(1))
        .refine((uris) => uris.join("\n").length <= 2000, "Too long"),
    scopes: ScopeList.optional()
        .transform((scopes) => scopes && scopes.length > 0 ? scopes : ["read" as const]),
    website: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2000)]).optional(),
});

const applicationOf = (app: AppsTable): Application => ({
    id: app.id,
    name: app.name,
    website: app.website,
    scopes: app.scopes,
    redirect_uris: app.redirect_uris,
    redirect_uri: app.redirect_uris.join("\n"),
});

const postApps = defineRoute({
    method: "POST",
    path: "/api/v1/apps",
    summary: "Registers a client app",
    body: AppForm,
    responses: { 200: CredentialApplication },
    handler: async (ctx, { body }) => {
        const { app, clientSecret } = await registerApp(ctx, {
            name: body.client_name,
            website: body.website || null,
            redirectUris: body.redirect_uris,
            scopes: body.scopes,
        });

        return {
            status: 200,
            body: {
                ...applicationOf(app),
                client_id: app.client_id,
                client_secret: clientSecret,
                client_secret_expires_at: 0 as const,
            },
        };
    },
});

const expired = {
    status: 400,
    page: errorPage("This login has expired. Go back to the app to try again."),
} as const;

/**
 * Sends the browser back to the app with a code or an error. An out-of-band app has nowhere to
 * send it, so the user is shown the code to copy, or the error.
 */
const sendBack = ({ redirectUri, params }: Omit<SendBack, "result">) => {
    if (redirectUri !== outOfBand) {
        return { status: 302, location: withParams(redirectUri, params) } as const;
    }

    return params.code === undefined
        ? { status: 400, page: errorPage(params.error_description ?? "") } as const
        : { status: 200, page: codePage(params.code) } as const;
};

/** The cookie that ties a login to the browser that started it. */
const FlowCookie = z.object({ oauth_flow: z.string().optional() });

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
    responses: { 200: Page, 302: Redirect, 400: Page },
    handler: async (ctx, { query }) => {
        const authorization = await authorize(ctx, query);

        switch (authorization.result) {
            case "refused":
                return { status: 400, page: errorPage(authorization.description) };

            case "error":
                return sendBack(authorization);

            case "choose":
                return {
                    status: 200,
                    page: chooserPage(authorization.issuers),
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
    body: z.object({ issuer: z.string() }),
    cookies: FlowCookie,
    responses: { 303: Redirect, 400: Page },
    handler: async (ctx, { body, cookies }) => {
        const url = await chooseIssuer(ctx, cookies.oauth_flow, body.issuer);

        return url ? { status: 303, location: url.href } : expired;
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

        return login.result === "expired" ? expired : sendBack(login);
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
    body: z.object({ decision: z.enum(["allow", "deny"]) }),
    cookies: FlowCookie,
    responses: { 200: Page, 302: Redirect, 400: Page },
    handler: async (ctx, { body, cookies }) => {
        const decision = await decide(ctx, cookies.oauth_flow, body.decision === "allow");
        if (decision.result === "expired") return expired;

        return { ...sendBack(decision), cookies: { oauth_flow: null } };
    },
});

export const authRoutes: readonly Route[] = [
    postApps,
    getAuthorize,
    postIssuer,
    getCallback,
    getConsent,
    postConsent,
];
