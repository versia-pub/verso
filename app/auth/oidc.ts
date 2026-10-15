import * as client from "@panva/openid-client";
import type { Claims, Issuer } from "../accounts/provision.ts";
import type { Clock } from "../kernel/clock.ts";
import type { Transport } from "../kernel/transport.ts";
import type { IdentityProvider } from "./identity.ts";

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
export const oidcProvider = (issuer: Issuer, options: OidcOptions): IdentityProvider => {
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
                scope: "openid profile",
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

            const tokens = await client.authorizationCodeGrant(await configuration(), returned, {
                pkceCodeVerifier: flow.codeVerifier,
                expectedState: flow.state,
                expectedNonce: flow.nonce,
                idTokenExpected: true,
            });

            return tokens.claims() as Claims;
        },
    };
};

/** A provider for each configured issuer, by issuer URL. */
export const oidcProviders = (
    issuers: readonly Issuer[],
    options: OidcOptions,
): Record<string, IdentityProvider> =>
    Object.fromEntries(issuers.map((issuer) => [issuer.url, oidcProvider(issuer, options)]));
