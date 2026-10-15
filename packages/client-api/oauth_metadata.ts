import { z } from "zod";

/**
 * How to use the server's OAuth endpoints, as RFC 8414 describes, plus Mastodon's
 * `app_registration_endpoint`.
 * @see https://docs.joinmastodon.org/methods/oauth/#authorization-server-metadata
 */
export const OAuthServerMetadata = z.object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    revocation_endpoint: z.url(),
    /** Where apps register, with `POST`. Mastodon's own field. */
    app_registration_endpoint: z.url(),
    scopes_supported: z.array(z.string()),
    response_types_supported: z.array(z.string()),
    response_modes_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
});
export type OAuthServerMetadata = z.infer<typeof OAuthServerMetadata>;
