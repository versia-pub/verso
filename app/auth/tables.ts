import type { LoginFlow } from "./identity.ts";
import type { Scope } from "./scopes.ts";

/** A client app, registered through `POST /api/v1/apps`. */
export type AppsTable = {
    id: string;
    name: string;
    website: string | null;
    redirect_uris: string[];
    /** The most an app may ask for when it logs a user in. */
    scopes: Scope[];
    /** Public: clients send it in the browser's address bar. */
    client_id: string;
    /** The secret is shown once, when the app registers, and only its hash is kept. */
    client_secret_hash: string;
    created_at: Date;
};

/**
 * One user authorising one app, from `/oauth/authorize` until the app trades its code for a token.
 * It is tied to the browser that started it by a cookie, whose hash is the id.
 */
export type OAuthFlowsTable = {
    id: string;
    app_id: string;
    /** One of the app's redirect URIs, which the client chose. */
    redirect_uri: string;
    scopes: Scope[];
    /** The client's `state`, sent back to it unchanged. */
    state: string | null;
    /** The client's S256 PKCE challenge, if it sent one. */
    code_challenge: string | null;
    /** The issuer the user logs in with, once chosen. */
    issuer: string | null;
    /** What the issuer's login needs back when the browser returns. */
    login: LoginFlow | null;
    /** The user, once logged in. */
    account_id: string | null;
    /**
     * Sent back by the forms shown during this flow, so a form left open from another flow, or
     * posted by another site, can't act on this one. `null` for flows from before it was added.
     */
    form_token: string | null;
    /** The hash of the code the app trades for a token, once the user allows it. */
    code_hash: string | null;
    expires_at: Date;
    created_at: Date;
};

/** A token an app sends to act for a user, or for itself. Only its hash is kept. */
export type AccessTokensTable = {
    id: string;
    token_hash: string;
    app_id: string;
    /** The user the app acts for, or `null` for a token the app got for itself. */
    account_id: string | null;
    scopes: Scope[];
    created_at: Date;
};
