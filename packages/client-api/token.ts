import { z } from "zod";

/**
 * An access token, for the `Authorization: Bearer` header.
 * @see https://docs.joinmastodon.org/entities/Token/
 */
export const Token = z.object({
    access_token: z.string(),
    token_type: z.literal("Bearer"),
    /** The scopes it grants, separated by spaces. */
    scope: z.string(),
    /** When it was created, in seconds since 1970. */
    created_at: z.number().int(),
});
export type Token = z.infer<typeof Token>;
