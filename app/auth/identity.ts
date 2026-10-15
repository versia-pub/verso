import type { Claims, Issuer } from "../accounts/provision.ts";

/** What a login needs to remember between sending the browser away and its return. */
export type LoginFlow = {
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
};

/** Logs users in with one issuer. Verso never sees their passwords. */
export type IdentityProvider = {
    /** The issuer's configuration: its name, and who may register through it. */
    readonly issuer: Issuer;
    /** Where to send the browser, and the flow to keep until it comes back to `redirectUri`. */
    beginLogin(redirectUri: string): Promise<{ url: URL; flow: LoginFlow }>;
    /** Checks the browser's return to `redirectUri` and returns the verified ID token's claims. */
    completeLogin(callback: URL, flow: LoginFlow): Promise<Claims>;
};
