import { type PushAlerts, WebPushSubscription } from "../web_push_subscription.ts";
import type { CallOptions, Http } from "./http.ts";

/** Where a browser takes pushes, as its `PushSubscription` gives it. */
export type PushEndpoint = {
    /** An `https` URL. */
    readonly endpoint: string;
    readonly keys: {
        /** The browser's P-256 public key, in URL-safe base64. */
        readonly p256dh: string;
        /** Its 16-byte auth secret, in URL-safe base64. */
        readonly auth: string;
    };
};

/** Which notifications to push. What is omitted is not pushed, and pushes are for everyone's. */
export type PushData = {
    /** Whether to push each type of notification. */
    readonly alerts?: Partial<PushAlerts>;
    /** Whose notifications to push. Defaults to `all`. */
    readonly policy?: WebPushSubscription["policy"];
};

/** Pushing the notifications of the viewer's token to a browser, with Web Push. */
export class PushMethods {
    constructor(private readonly http: Http) {}

    /**
     * Pushes the token's notifications to `subscription`, replacing where it pushed them before.
     * @see https://docs.joinmastodon.org/methods/push/#create
     */
    subscribe(
        subscription: PushEndpoint,
        data: PushData = {},
        options?: CallOptions,
    ): Promise<WebPushSubscription> {
        return this.http.json(WebPushSubscription, "POST", "/api/v1/push/subscription", {
            ...options,
            json: { subscription, data },
        });
    }

    /**
     * Where the token's notifications are pushed, and which.
     * @see https://docs.joinmastodon.org/methods/push/#get
     */
    get(options?: CallOptions): Promise<WebPushSubscription> {
        return this.http.json(WebPushSubscription, "GET", "/api/v1/push/subscription", options);
    }

    /**
     * Changes which notifications are pushed. What is omitted is reset, as when subscribing.
     * @see https://docs.joinmastodon.org/methods/push/#update
     */
    update(data: PushData, options?: CallOptions): Promise<WebPushSubscription> {
        return this.http.json(WebPushSubscription, "PUT", "/api/v1/push/subscription", {
            ...options,
            json: { data },
        });
    }

    /**
     * Stops pushing the token's notifications.
     * @see https://docs.joinmastodon.org/methods/push/#delete
     */
    async unsubscribe(options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", "/api/v1/push/subscription", options);
    }
}
