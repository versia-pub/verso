import { html } from "@hono/hono/html";
import { layout } from "../http/page.ts";
import type { Html } from "../http/route.ts";
import type { ConsentRequest } from "./consent.ts";
import type { IdentityProvider } from "./identity.ts";

/** Tells the user why they can't log in, when there is no app to send them back to. */
export const errorPage = (description: string): Html =>
    layout("Can't log in", html`<p>${description}</p>`);

/** One button for each issuer the user can log in with. */
export const chooserPage = (issuers: IdentityProvider["issuer"][]): Html =>
    layout(
        "Log in",
        html`
            <form method="post" action="/oauth/authorize/issuer">
                ${issuers.map((issuer) =>
                    html`<p><button name="issuer" value="${issuer.url}">${issuer.name}</button></p>`
                )}
            </form>
        `,
    );

/** Asks the user whether to let the app use their account. */
export const consentPage = (request: ConsentRequest): Html =>
    layout(
        `Allow ${request.appName}?`,
        html`
            <p>${request.appName} wants to use your account @${request
                .username} with these permissions:</p>
            <ul>${request.scopes.map((scope) => html`<li><code>${scope}</code></li>`)}</ul>
            <form method="post" action="/oauth/consent">
                <button name="decision" value="allow">Allow</button>
                <button name="decision" value="deny">Deny</button>
            </form>
        `,
    );

/** Shows the code to an app that can't receive it, for the user to copy into the app. */
export const codePage = (code: string): Html =>
    layout("Copy this code into the app", html`<p><code>${code}</code></p>`);
