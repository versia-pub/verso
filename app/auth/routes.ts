import { type Application, CredentialApplication } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, Page, Redirect, type Route } from "../http/route.ts";
import { registerApp } from "./apps.ts";
import { authorize, outOfBand, withParams } from "./authorize.ts";
import { chooserPage, errorPage } from "./pages.ts";
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
                return authorization.redirectUri === outOfBand
                    ? { status: 400, page: errorPage(authorization.params.error_description ?? "") }
                    : {
                        status: 302,
                        location: withParams(authorization.redirectUri, authorization.params),
                    };

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

export const authRoutes: readonly Route[] = [postApps, getAuthorize];
