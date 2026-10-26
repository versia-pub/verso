import { z } from "zod";

/**
 * How the viewer and another account are connected.
 * @see https://docs.joinmastodon.org/entities/Relationship/
 */
export const Relationship = z.object({
    /** The other account's id. */
    id: z.string(),
    following: z.boolean(),
    /** Whether the account's boosts appear in the viewer's home timeline. */
    showing_reblogs: z.boolean(),
    /** Whether the viewer is notified when the account posts. */
    notifying: z.boolean(),
    /** The languages the viewer follows the account in, as ISO 639-1 codes, or `null` for all. */
    languages: z.array(z.string()).nullable(),
    followed_by: z.boolean(),
    blocking: z.boolean(),
    blocked_by: z.boolean(),
    muting: z.boolean(),
    muting_notifications: z.boolean(),
    /** When the viewer's mute of the account ends, or `null` if it doesn't. */
    muting_expires_at: z.iso.datetime().nullable(),
    /** Whether the viewer's follow request to the account is pending. */
    requested: z.boolean(),
    /** Whether the account's follow request to the viewer is pending. */
    requested_by: z.boolean(),
    /** Whether the viewer blocks the account's whole domain. */
    domain_blocking: z.boolean(),
    /** Whether the viewer features the account on their profile. */
    endorsed: z.boolean(),
    /** The viewer's private note about the account. */
    note: z.string(),
});
export type Relationship = z.infer<typeof Relationship>;
