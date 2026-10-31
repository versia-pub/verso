import { z } from "zod";

/** What a policy does with the notifications it applies to. */
export const PolicyAction = z.enum(["accept", "filter", "drop"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

/**
 * What the viewer's policy does with notifications from accounts of each kind: `accept` them,
 * `filter` them, which keeps them aside, or `drop` them, which makes none.
 * @see https://docs.joinmastodon.org/entities/NotificationPolicy/
 */
export const NotificationPolicy = z.object({
    /** From accounts the viewer doesn't follow. */
    for_not_following: PolicyAction,
    /** From accounts that don't follow the viewer, or only started to in the last 3 days. */
    for_not_followers: PolicyAction,
    /** From accounts made in the last 30 days. */
    for_new_accounts: PolicyAction,
    /** Of direct statuses, unless they reply to the viewer's own, or are from accounts they follow. */
    for_private_mentions: PolicyAction,
    /** From accounts a moderator limited. */
    for_limited_accounts: PolicyAction,
    summary: z.object({
        /** How many accounts the viewer has filtered mentions from, counting up to 100. */
        pending_requests_count: z.int(),
        /** How many filtered mentions there are in those. */
        pending_notifications_count: z.int(),
    }),
});
export type NotificationPolicy = z.infer<typeof NotificationPolicy>;
