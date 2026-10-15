import { html } from "@hono/hono/html";
import { layout } from "../http/page.ts";
import type { Html } from "../http/route.ts";
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
