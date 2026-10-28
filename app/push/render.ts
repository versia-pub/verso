import { PushAlerts, type WebPushSubscription } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { vapidPublicKey } from "./keys.ts";
import type { PushSubscriptionRow } from "./subscription_queries.ts";

/** The types of notifications a subscription may push, as Mastodon names them in `alerts`. */
export const alertNames = PushAlerts.keyof().options;

/** A subscription as Mastodon's API shows it. */
export const renderSubscription = async (
    ctx: Context,
    row: PushSubscriptionRow,
): Promise<WebPushSubscription> => ({
    id: row.id,
    endpoint: row.endpoint,
    alerts: PushAlerts.parse(
        Object.fromEntries(alertNames.map((name) => [name, row.alerts.includes(name)])),
    ),
    server_key: await vapidPublicKey(ctx),
    policy: row.policy,
});
