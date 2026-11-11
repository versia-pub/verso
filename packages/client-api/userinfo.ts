import { z } from "zod";

/**
 * The OpenID Connect claims about the user a token acts for.
 * @see https://docs.joinmastodon.org/methods/oauth/#userinfo
 */
export const UserInfo = z.object({
    /** The server's URL. */
    iss: z.url(),
    /** The account's URI. */
    sub: z.url(),
    /** The account's display name. */
    name: z.string(),
    /** The account's username. */
    preferred_username: z.string(),
    /** The account's profile page. */
    profile: z.url(),
    /** The account's avatar. */
    picture: z.url(),
});
export type UserInfo = z.infer<typeof UserInfo>;
