import type { Context } from "../kernel/context.ts";
import type { IdentityProvider, Issuer } from "../kernel/identity.ts";
import { type AppRegistration, registerApp } from "./apps.ts";
import type { Scope } from "./scopes.ts";
import type { AppsTable } from "./tables.ts";
import { issueToken } from "./tokens.ts";

/**
 * An access token, for tests that skip logging in: for the account, or for an app itself with
 * `null`. It has the scopes a usual client asks for, unless others are given.
 */
export const tokenFor = async (
    ctx: Context,
    accountId: string | null,
    scopes: Scope[] = ["read", "write", "follow", "push"],
): Promise<string> => {
    const { app } = await registerApp(ctx, {
        name: "Test app",
        website: null,
        redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
        scopes,
    });

    return (await issueToken(ctx, app, accountId, scopes)).token;
};

/** Phanpy, registered with a web redirect URI and an out-of-band one, unless `changes` say. */
export const registerTestApp = (
    ctx: Context,
    changes: Partial<AppRegistration> = {},
): Promise<{ app: AppsTable; clientSecret: string }> =>
    registerApp(ctx, {
        name: "Phanpy",
        website: null,
        redirectUris: ["https://phanpy.example/back", "urn:ietf:wg:oauth:2.0:oob"],
        scopes: ["read", "write"],
        ...changes,
    });

/**
 * An issuer that sends the browser to its own `/authorize`, naming where it should come back, and
 * logs in alice when the browser comes back with `code=good`.
 */
export const stubProvider = (issuer: Partial<Issuer> = {}): IdentityProvider => {
    const url = issuer.url ?? "https://id.example";

    return {
        issuer: {
            name: "Example",
            url,
            username_claim: "preferred_username",
            registration: "open",
            ...issuer,
        },
        beginLogin: (redirectUri) =>
            Promise.resolve({
                url: new URL(`${url}/authorize?back=${encodeURIComponent(redirectUri)}`),
                flow: { redirectUri, state: "s", nonce: "n", codeVerifier: "v" },
            }),
        completeLogin: (callback) =>
            callback.searchParams.get("code") === "good"
                ? Promise.resolve({ sub: "1", preferred_username: "alice" })
                : Promise.reject(new Error("The issuer refused the code")),
    };
};

/** The login's cookie that a response sets, or "" if it sets none. */
export const flowCookie = (response: Response): string =>
    /__Host-oauth_flow=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";

/** The form token on a chooser or consent page, or "" if there is none. */
export const formTokenIn = (page: string): string =>
    /name="form_token" value="([^"]+)"/.exec(page)?.[1] ?? "";
