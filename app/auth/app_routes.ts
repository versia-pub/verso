import { Application, CredentialApplication } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, type Route } from "../http/route.ts";
import { registerApp } from "./apps.ts";
import { getApp } from "./app_queries.ts";
import { ScopeList } from "../kernel/scopes.ts";
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

/**
 * Any valid token works, with no scope needed, as since Mastodon 4.3.
 * @see https://docs.joinmastodon.org/methods/apps/#verify_credentials
 */
const verifyAppCredentials = defineRoute({
    method: "GET",
    path: "/api/v1/apps/verify_credentials",
    summary: "Shows the app a token belongs to",
    auth: { require: "app" },
    responses: { 200: Application },
    handler: async (ctx, { viewer }) => ({
        status: 200,
        body: applicationOf(await getApp(ctx, viewer.appId)),
    }),
});

/** Registering apps, and checking an app's token. */
export const appRoutes: readonly Route[] = [postApps, verifyAppCredentials];
