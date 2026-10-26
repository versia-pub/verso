/**
 * Sending entities to remote Versia instances: one job per instance, for the delivery worker.
 * @see https://versia.pub/federation/http
 * @module
 */
import { z } from "zod";
import { instancesHosting } from "../accounts/account_queries.ts";
import { reachableDomainsOf } from "../instances/instance_queries.ts";
import { enqueueAll } from "../jobs/job_queries.ts";
import type { Context } from "../kernel/context.ts";

/** Versia's own queue, so deliveries of other protocols can't hold it up. */
export const deliverQueue = "versia-deliver";

/** The payload of a delivery job. */
export const DeliverJob = z.object({
    /** The domain of the instance to send it to. */
    domain: z.string(),
    /** The entity, serialised once when queued, so later changes can't alter what is sent. */
    body: z.string(),
});
export type DeliverJob = z.infer<typeof DeliverJob>;

/**
 * More than are ever made: deliveries are given up on by age, after as long as the settings say (at
 * most 30 days), with at most six hours between attempts.
 */
const maxAttempts = 1000;

/**
 * Queues `entity` for delivery to each of `instanceIds` that is a Versia instance, grouped by
 * instance so each can be rate limited. Skips blocked instances, and instances that couldn't be
 * reached for as long as the settings say, as on Mastodon, until they are heard from again.
 */
export const queueDeliveriesTo = async (
    ctx: Context,
    entity: object,
    instanceIds: readonly string[],
): Promise<void> => {
    const body = JSON.stringify(entity);

    const jobs = [];
    const before = new Date(ctx.clock.now().getTime() - ctx.settings.unreachableMs);
    for (const domain of await reachableDomainsOf(ctx, instanceIds, "versia", before)) {
        if (await ctx.federation.isBlocked(ctx, domain)) continue;

        const payload: DeliverJob = { domain, body };
        // Deliveries are numerous, so workers find them by polling.
        jobs.push({ queue: deliverQueue, payload, maxAttempts, group: domain, wake: false });
    }
    await enqueueAll(ctx, jobs);
};

/**
 * Queues `entity` for delivery to each instance that hosts any of `recipients`, which are account
 * ids, as {@link queueDeliveriesTo} does. Local accounts need nothing delivered. This is for a few
 * accounts, such as those mentioned by a status; an account's followers are found through their
 * instances instead.
 */
export const queueDeliveries = async (
    ctx: Context,
    entity: object,
    recipients: readonly string[],
): Promise<void> => await queueDeliveriesTo(ctx, entity, await instancesHosting(ctx, recipients));
