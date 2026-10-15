import { html } from "@hono/hono/html";
import { z } from "zod";
import { layout } from "../http/page.ts";
import { defineRoute, Page, type Route } from "../http/route.ts";
import type { IdentityProvider, Issuer } from "../kernel/identity.ts";
import type { UrlBuilder } from "../kernel/urls.ts";
import { randomToken } from "./secrets.ts";

/** The dev login, as an issuer anyone may register with. */
export const devIssuer = (urls: UrlBuilder): Issuer => ({
    name: "Development login",
    url: urls.url`/oauth/dev-login`,
    username_claim: "preferred_username",
    registration: "open",
});

/**
 * Logs in as any username, with no password, for running Verso locally without an identity
 * provider. The config only allows it in development mode.
 */
export const devLoginProvider = (urls: UrlBuilder): IdentityProvider => {
    const issuer = devIssuer(urls);

    return {
        issuer,

        beginLogin: (redirectUri) => {
            const state = randomToken();
            const url = new URL(issuer.url);
            url.searchParams.set("state", state);

            return Promise.resolve({
                url,
                flow: { redirectUri, state, nonce: "", codeVerifier: "" },
            });
        },

        completeLogin: (callback, flow) => {
            const username = callback.searchParams.get("username");

            if (callback.searchParams.get("state") !== flow.state || !username) {
                return Promise.reject(new Error("The dev login's state or username is wrong"));
            }

            return Promise.resolve({ sub: username, preferred_username: username });
        },
    };
};

/** The form goes straight back to the callback, as an identity provider would. */
const getDevLogin = defineRoute({
    method: "GET",
    path: "/oauth/dev-login",
    summary: "Asks who to log in as, in development",
    query: z.object({ state: z.string() }),
    responses: { 200: Page },
    handler: (_, { query }) =>
        Promise.resolve({
            status: 200,
            page: layout(
                "Log in as",
                html`
                    <form method="get" action="/oauth/callback">
                        <input type="hidden" name="state" value="${query.state}">
                        <p><input name="username" required autofocus></p>
                        <button>Log in</button>
                    </form>
                `,
            ),
        }),
});

/** Added only when `auth.dev_login` is on, so production servers don't have them at all. */
export const devLoginRoutes: readonly Route[] = [getDevLogin];
