import type { PushAlerts } from "@versia/client-api";

/**
 * The key pair this instance signs Web Push requests with, as VAPID. There is only ever one,
 * because changing it would break every subscription.
 * @see https://www.rfc-editor.org/rfc/rfc8292
 */
export type VapidKeysTable = {
    id: string;
    /** The P-256 public key, as an uncompressed point, in base64. */
    public_key: string;
    /** PKCS #8, in base64. */
    private_key: string;
    created_at: Date;
};

/** A type of notification a subscription may push, by its name in `alerts`. */
export type PushAlert = keyof PushAlerts;

/** Whose notifications are pushed, as a subscription's `policy` says. */
export type PushPolicy = "all" | "followed" | "follower" | "none";

/**
 * Where an access token's notifications are pushed to, with Web Push. Each token has one at most,
 * and loses it when it is revoked.
 * @see https://www.rfc-editor.org/rfc/rfc8030
 */
export type PushSubscriptionsTable = {
    id: string;
    token_id: string;
    /** The user the token is for, whose notifications are pushed. */
    account_id: string;
    /**
     * The token itself, which only this table keeps. Pushes carry it, like Mastodon's, for clients
     * to fetch the notification with.
     */
    access_token: string;
    endpoint: string;
    /** The client's P-256 public key, as an uncompressed point, in URL-safe base64. */
    p256dh: string;
    /** The client's secret for the encryption, in URL-safe base64. */
    auth: string;
    /** The types of notifications pushed, by their names in `alerts`. */
    alerts: PushAlert[];
    policy: PushPolicy;
    /**
     * Whether pushes are in the `aes128gcm` encoding, rather than the older `aesgcm` one. The
     * client chose when subscribing.
     */
    standard: boolean;
    created_at: Date;
};
