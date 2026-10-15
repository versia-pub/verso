import { z } from "zod";

/**
 * An app registered to use the API.
 * @see https://docs.joinmastodon.org/entities/Application/
 */
export const Application = z.object({
    /**
     * Mastodon's ids are numbers in strings and Verso's are UUIDs; clients treat both as opaque.
     */
    id: z.string(),
    name: z.string(),
    /** The app's home page, or `null` if it gave none. */
    website: z.string().nullable(),
    scopes: z.array(z.string()),
    redirect_uris: z.array(z.string()),
    /**
     * The redirect URIs, one per line.
     * @deprecated Since Mastodon 4.3. Use `redirect_uris`.
     */
    redirect_uri: z.string(),
});
export type Application = z.infer<typeof Application>;

/**
 * An app with the credentials it gets tokens with, returned only when it registers.
 * @see https://docs.joinmastodon.org/entities/Application/#CredentialApplication
 */
export const CredentialApplication = Application.extend({
    client_id: z.string(),
    client_secret: z.string(),
    /** Always 0, since secrets don't expire. */
    client_secret_expires_at: z.literal(0),
});
export type CredentialApplication = z.infer<typeof CredentialApplication>;
