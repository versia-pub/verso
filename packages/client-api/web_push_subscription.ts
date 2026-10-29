import { z } from "zod";

/** Which notifications are pushed, by their type, as Mastodon names them. */
export const PushAlerts = z.object({
    mention: z.boolean(),
    status: z.boolean(),
    reblog: z.boolean(),
    follow: z.boolean(),
    follow_request: z.boolean(),
    favourite: z.boolean(),
    poll: z.boolean(),
    update: z.boolean(),
    "admin.sign_up": z.boolean(),
    "admin.report": z.boolean(),
    /** Reactions with emojis, which Mastodon doesn't have. */
    reaction: z.boolean(),
});
export type PushAlerts = z.infer<typeof PushAlerts>;

/**
 * Where an access token's notifications are pushed to, with Web Push, and which.
 * @see https://docs.joinmastodon.org/entities/WebPushSubscription/
 */
export const WebPushSubscription = z.object({
    /**
     * Mastodon's ids are numbers in strings and Verso's are UUIDs; clients treat both as opaque.
     */
    id: z.string(),
    /** Where the notifications are pushed to. */
    endpoint: z.string(),
    alerts: PushAlerts,
    /** The instance's VAPID public key, which push services check the pushes are signed with. */
    server_key: z.string(),
    /**
     * Whose notifications are pushed: everyone's, or only those the user follows, or who follow
     * them, or no one's.
     */
    policy: z.enum(["all", "followed", "follower", "none"]),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;
