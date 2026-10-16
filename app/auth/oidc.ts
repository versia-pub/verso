import * as client from "@panva/openid-client";
import type { Clock } from "../kernel/clock.ts";
import type { Claims, IdentityProvider, IssuerConfig } from "../kernel/identity.ts";
import type { Transport } from "../kernel/transport.ts";

export type OidcOptions = {
    readonly transport: Transport;
    readonly clock: Clock;
};

/** openid-client's `customFetch`, sending through a transport. Its body types are just looser. */
export const openidFetch = (transport: Transport): client.CustomFetch => (url, options) =>
    transport(new Request(url, options as RequestInit));

/**
 * An identity provider for an OpenID Connect issuer, using the code flow with PKCE. The issuer is
 * discovered on first use; if that fails, the next login tries again.
 */
export const oidcProvider = (issuer: IssuerConfig, options: OidcOptions): IdentityProvider => {
    const fetch = openidFetch(options.transport);
    let discovered: Promise<client.ServerMetadata> | undefined;

    const discover = () => {
        discovered ??= client
            .discovery(new URL(issuer.url), issuer.client_id, undefined, undefined, {
                [client.customFetch]: fetch,
            })
            .then((configuration) => configuration.serverMetadata())
            .catch((error) => {
                discovered = undefined;
                throw error;
            });
        return discovered;
    };

    // openid-client reads the time once per configuration, so each login gets its own, with the
    // context's clock as "now".
    const configuration = async () => {
        const skew = Math.round((options.clock.now().getTime() - Date.now()) / 1000);
        const configuration = new client.Configuration(await discover(), issuer.client_id, {
            client_secret: issuer.client_secret,
            [client.clockSkew]: skew,
        });
        configuration[client.customFetch] = fetch;
        return configuration;
    };

    return {
        issuer,

        beginLogin: async (redirectUri) => {
            const flow = {
                redirectUri,
                state: client.randomState(),
                nonce: client.randomNonce(),
                codeVerifier: client.randomPKCECodeVerifier(),
            };

            const url = client.buildAuthorizationUrl(await configuration(), {
                redirect_uri: redirectUri,
                scope: [...new Set(["openid", "profile", ...issuer.scopes])].join(" "),
                state: flow.state,
                nonce: flow.nonce,
                code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
                code_challenge_method: "S256",
            });

            return { url, flow };
        },

        completeLogin: async (callback, flow) => {
            // Only the query comes from the browser; the redirect URI is ours, whatever the
            // request URL looked like behind a proxy.
            const returned = new URL(flow.redirectUri);
            returned.search = callback.search;

            const config = await configuration();
            const tokens = await client.authorizationCodeGrant(config, returned, {
                pkceCodeVerifier: flow.codeVerifier,
                expectedState: flow.state,
                expectedNonce: flow.nonce,
                idTokenExpected: true,
            });
            const claims = tokens.claims() as Claims;

            // Many issuers leave claims such as groups out of the ID token, and only give them
            // here. Where both have a claim, the signed ID token's wins.
            if (config.serverMetadata().userinfo_endpoint === undefined) return claims;

            const userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
            return { ...userinfo, ...claims };
        },
    };
};

/** A provider for each configured issuer, by issuer URL. */
export const oidcProviders = (
    issuers: readonly IssuerConfig[],
    options: OidcOptions,
): Record<string, IdentityProvider> =>
    Object.fromEntries(issuers.map((issuer) => [issuer.url, oidcProvider(issuer, options)]));
