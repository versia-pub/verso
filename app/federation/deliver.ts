/**
 * Sending entities to other Versia instances: one job for each instance, for the delivery worker.
 * @see https://versia.pub/federation/http
 * @module
 */
import { z } from "zod";
import { domainsHosting } from "../instances/instances.ts";
import { enqueue } from "../jobs/queue.ts";
import type { Context } from "../kernel/context.ts";

/** Versia's own, so other protocols' deliveries can't hold it up. */
export const deliverQueue = "versia-deliver";

/** A delivery job's payload. */
export const DeliverJob = z.object({
    /** The domain of the instance to send it to. */
    domain: z.string(),
    /** The entity, serialised once when queued, so later changes can't alter what is sent. */
    body: z.string(),
});
export type DeliverJob = z.infer<typeof DeliverJob>;

/** More than are ever made: deliveries are given up on by age, after 48 hours. */
const maxAttempts = 100;

/**
 * Queues `entity` for each Versia instance that hosts any of `recipients`, which are account ids,
 * except blocked ones, grouped by instance so each can be limited. Local accounts need nothing
 * delivered.
 */
export const queueDeliveries = async (
    ctx: Context,
    entity: object,
    recipients: readonly string[],
): Promise<void> => {
    const body = JSON.stringify(entity);

    for (const domain of await domainsHosting(ctx, recipients, "versia")) {
        if (await ctx.federation.isBlocked(ctx, domain)) continue;

        const payload: DeliverJob = { domain, body };
        await enqueue(ctx, { queue: deliverQueue, payload, maxAttempts, group: domain });
    }
};
