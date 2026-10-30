/**
 * Registering an app, and logging users in to it with OAuth.
 * @see https://docs.joinmastodon.org/client/token/
 * @module
 */
import { Application, CredentialApplication } from "../application.ts";
import { OAuthServerMetadata } from "../oauth_metadata.ts";
import { Token } from "../token.ts";
import type { CallOptions, Http } from "./http.ts";

/** The redirect URI that shows the user the code to copy, for apps that can't receive one. */
export const outOfBand = "urn:ietf:wg:oauth:2.0:oob";

/** An app, as it registers. */
export type AppRegistration = {
    readonly client_name: string;
    /** Where users may be sent back to after logging in, such as `outOfBand`. */
    readonly redirect_uris: readonly string[];
    /** The most the app may ask for. Defaults to `read`. */
    readonly scopes?: readonly string[];
    readonly website?: string;
};

/** An app's credentials, from registering it. */
export type AppCredentials = {
    readonly client_id: string;
    readonly client_secret: string;
};

/** Where to send the user to log in, and what the code will need. */
export type Authorization = {
    readonly client_id: string;
    readonly redirect_uri: string;
    /** Defaults to `read`. */
    readonly scopes?: readonly string[];
    /** Given back with the code, so the app can tell the answer is to its own request. */
    readonly state?: string;
    /** From `createPkce`, so a code that leaks is no use without its verifier. */
    readonly code_challenge?: string;
};

/** A verifier, kept by the app, and the challenge made from it, sent with the user. */
export type Pkce = {
    readonly verifier: string;
    readonly challenge: string;
};

/** Base64url, without padding, as PKCE uses. */
const base64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(
        /=+$/,
        "",
    );

/**
 * A new PKCE verifier and its S256 challenge.
 * @see https://www.rfc-editor.org/rfc/rfc7636#section-4
 */
export const createPkce = async (): Promise<Pkce> => {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

    return { verifier, challenge: base64url(new Uint8Array(digest)) };
};

/** Registers apps, and gets and revokes their tokens. */
export class OAuth {
    constructor(private readonly http: Http) {}

    /**
     * Registers an app. Its secret is given only this once.
     * @see https://docs.joinmastodon.org/methods/apps/#create
     */
    registerApp(app: AppRegistration, options?: CallOptions): Promise<CredentialApplication> {
        return this.http.json(CredentialApplication, "POST", "/api/v1/apps", {
            ...options,
            json: { ...app, scopes: app.scopes?.join(" ") },
        });
    }

    /**
     * The app the token belongs to.
     * @see https://docs.joinmastodon.org/methods/apps/#verify_credentials
     */
    verifyApp(options?: CallOptions): Promise<Application> {
        return this.http.json(Application, "GET", "/api/v1/apps/verify_credentials", options);
    }

    /**
     * Where to send the user to log in. They come back to the redirect URI with a `code`, for
     * `token`, or are shown it to copy with `outOfBand`.
     * @see https://docs.joinmastodon.org/methods/oauth/#authorize
     */
    authorizationUrl(authorization: Authorization): URL {
        const url = new URL("/oauth/authorize", this.http.url);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", authorization.client_id);
        url.searchParams.set("redirect_uri", authorization.redirect_uri);
        url.searchParams.set("scope", (authorization.scopes ?? ["read"]).join(" "));
        if (authorization.state !== undefined) url.searchParams.set("state", authorization.state);
        if (authorization.code_challenge !== undefined) {
            url.searchParams.set("code_challenge", authorization.code_challenge);
            url.searchParams.set("code_challenge_method", "S256");
        }

        return url;
    }

    /**
     * Exchanges the code the user came back with for their token. The code works once.
     * @see https://docs.joinmastodon.org/methods/oauth/#token
     */
    exchangeCode(
        app: AppCredentials,
        code: {
            readonly code: string;
            readonly redirect_uri: string;
            readonly code_verifier?: string;
        },
        options?: CallOptions,
    ): Promise<Token> {
        return this.http.json(Token, "POST", "/oauth/token", {
            ...options,
            urlencoded: { grant_type: "authorization_code", ...app, ...code },
        });
    }

    /**
     * A token for the app itself, which acts for no user.
     * @see https://docs.joinmastodon.org/methods/oauth/#token
     */
    appToken(
        app: AppCredentials,
        scopes?: readonly string[],
        options?: CallOptions,
    ): Promise<Token> {
        return this.http.json(Token, "POST", "/oauth/token", {
            ...options,
            urlencoded: { grant_type: "client_credentials", ...app, scope: scopes?.join(" ") },
        });
    }

    /**
     * Revokes a token the app was given, and closes the streams it opened.
     * @see https://docs.joinmastodon.org/methods/oauth/#revoke
     */
    async revoke(app: AppCredentials, token: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", "/oauth/revoke", {
            ...options,
            urlencoded: { ...app, token },
        });
    }

    /**
     * Where the OAuth endpoints are, and what they support.
     * @see https://docs.joinmastodon.org/methods/oauth/#authorization-server-metadata
     */
    metadata(options?: CallOptions): Promise<OAuthServerMetadata> {
        return this.http.json(
            OAuthServerMetadata,
            "GET",
            "/.well-known/oauth-authorization-server",
            options,
        );
    }
}
