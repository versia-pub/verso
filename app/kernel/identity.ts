import type { Config } from "./config.ts";

/** An issuer as configured, with the credentials only its provider uses. */
export type IssuerConfig = Config["auth"]["issuers"][number];

/** What the rest of Verso knows about an issuer. */
export type Issuer = Pick<IssuerConfig, "name" | "url" | "username_claim" | "registration">;

/** The claims of a verified ID token. */
export type Claims = { readonly sub: string } & Readonly<Record<string, unknown>>;

/** What a login needs to remember between sending the browser away and its return. */
export type LoginFlow = {
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
};

/** Logs users in with one issuer. Verso never sees their passwords. */
export type IdentityProvider = {
    /** The issuer's name, and who may register through it. */
    readonly issuer: Issuer;
    /** Where to send the browser, and the flow to keep until it comes back to `redirectUri`. */
    beginLogin(redirectUri: string): Promise<{ url: URL; flow: LoginFlow }>;
    /** Checks the browser's return to `redirectUri` and returns the verified ID token's claims. */
    completeLogin(callback: URL, flow: LoginFlow): Promise<Claims>;
};
