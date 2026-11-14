import { z } from "zod";
import { ReferenceText, TransientEntity } from "./common.ts";

/**
 * The fields of the four subscription entities, none of which has an `author`. `target_type` is the
 * type of the entity `target` points to, like `User`.
 */
const Subscription = TransientEntity.extend({
    subscriber: ReferenceText,
    target: ReferenceText,
    target_type: z.string(),
});

/**
 * `subscriber` asks to subscribe to `target`. Sent by the subscriber's instance.
 * @see https://versia.pub/entities/subscribe
 */
export const Subscribe = Subscription.extend({ type: z.literal("Subscribe") });
export type Subscribe = z.infer<typeof Subscribe>;

/**
 * `target` accepts `subscriber`. Sent by the target's instance.
 * @see https://versia.pub/entities/subscribe-accept
 */
export const SubscribeAccept = Subscription.extend({ type: z.literal("SubscribeAccept") });
export type SubscribeAccept = z.infer<typeof SubscribeAccept>;

/**
 * `target` rejects or removes `subscriber`. Sent by the target's instance.
 * @see https://versia.pub/entities/subscribe-reject
 */
export const SubscribeReject = Subscription.extend({ type: z.literal("SubscribeReject") });
export type SubscribeReject = z.infer<typeof SubscribeReject>;

/**
 * `subscriber` stops subscribing to `target`, or cancels a pending request. Sent by the
 * subscriber's instance.
 * @see https://versia.pub/entities/unsubscribe
 */
export const Unsubscribe = Subscription.extend({ type: z.literal("Unsubscribe") });
export type Unsubscribe = z.infer<typeof Unsubscribe>;
