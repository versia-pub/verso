/**
 * Sending entities to other Versia instances: one job for each instance, for the delivery worker.
 * @see https://versia.pub/federation/http
 * @module
 */
import { z } from "zod";
import { instancesHosting } from "../accounts/account_queries.ts";
import { reachableDomainsOf } from "../instances/instances.ts";
import { enqueueAll } from "../jobs/queue.ts";
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
 * Queues `entity` for each of `instanceIds` that is a Versia instance, grouped by instance so each
 * can be limited, except blocked ones, and ones that couldn't be reached for as long as settings
 * say, as on Mastodon, until they are heard from again.
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
        jobs.push({ queue: deliverQueue, payload, maxAttempts, group: domain });
    }
    await enqueueAll(ctx, jobs);
};

/**
 * Queues `entity` for each instance that hosts any of `recipients`, which are account ids, as
 * {@link queueDeliveriesTo} does. Local accounts need nothing delivered. For a few accounts, such
 * as those a note mentions; an account's followers are found by their instances instead.
 */
export const queueDeliveries = async (
    ctx: Context,
    entity: object,
    recipients: readonly string[],
): Promise<void> => await queueDeliveriesTo(ctx, entity, await instancesHosting(ctx, recipients));
