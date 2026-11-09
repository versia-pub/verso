/**
 * Sending entities to remote Versia instances: one job per instance, for the delivery worker, each
 * referring to the entity, which is stored once.
 * @see https://versia.pub/federation/http
 * @module
 */
import type { SelectQueryBuilder } from "kysely";
import { z } from "zod";
import type { Database } from "../db/database.ts";
import { instancesHosting } from "../accounts/account_queries.ts";
import { reachableDomainsOf } from "../instances/instance_queries.ts";
import { enqueueAll } from "../jobs/job_queries.ts";
import type { Context } from "../kernel/context.ts";

/** Versia's own queue, so deliveries of other protocols can't hold it up. */
export const deliverQueue = "versia-deliver";

/** The payload of a delivery job. */
export const DeliverJob = z.union([
    z.object({
        /** The domain of the instance to send it to. */
        domain: z.string(),
        /** The entity's row in `delivery_bodies`, shared by its deliveries to every instance. */
        bodyId: z.string(),
    }),
    // Queued before bodies were stored once: the entity itself.
    z.object({ domain: z.string(), body: z.string() }),
]);
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
    const before = new Date(ctx.clock.now().getTime() - ctx.settings.unreachableMs);
    const domains = [];
    for (const domain of await reachableDomainsOf(ctx, instanceIds, "versia", before)) {
        if (!await ctx.federation.isBlocked(ctx, domain)) domains.push(domain);
    }
    if (domains.length === 0) return;

    // Stored once, however many instances it goes to.
    const bodyId = ctx.ids();
    await ctx.db.insertInto("delivery_bodies")
        .values({ id: bodyId, body: JSON.stringify(entity), created_at: ctx.clock.now() })
        .execute();

    await enqueueAll(
        ctx,
        domains.map((domain) => ({
            queue: deliverQueue,
            payload: { domain, bodyId } satisfies DeliverJob,
            maxAttempts,
            group: domain,
            // Deliveries are numerous, so workers find them by polling.
            wake: false,
        })),
    );
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

/**
 * The entity a delivery job sends, and when it was queued, or undefined if it was deleted, as it is
 * once its deliveries are given up on.
 */
export const deliveryBody = async (
    ctx: Context,
    job: DeliverJob,
    queuedAt: Date,
): Promise<{ body: string; queuedAt: Date } | undefined> => {
    if ("body" in job) return { body: job.body, queuedAt };

    const row = await ctx.db.selectFrom("delivery_bodies").select(["body", "created_at"])
        .where("id", "=", job.bodyId).executeTakeFirst();
    return row && { body: row.body, queuedAt: row.created_at };
};

/**
 * The entities queued before `before`, which is as long ago as deliveries are tried. Exported for
 * the tests of its query plan.
 */
export const expiredDeliveryBodies = (
    ctx: Context,
    before: Date,
): SelectQueryBuilder<Database, "delivery_bodies", { id: string }> =>
    ctx.db.selectFrom("delivery_bodies").select("id").where("created_at", "<=", before);

/**
 * Deletes the entities whose deliveries have all been given up on, `batchSize` at a time. Each
 * delivery is given up on as long after its entity was queued as the settings say, so none needs
 * them any more.
 */
export const deleteExpiredDeliveryBodies = async (
    ctx: Context,
    batchSize = 1000,
): Promise<void> => {
    const before = new Date(ctx.clock.now().getTime() - ctx.settings.deliveryMs);
    for (;;) {
        const deleted = await ctx.db.deleteFrom("delivery_bodies")
            .where("id", "in", expiredDeliveryBodies(ctx, before).limit(batchSize))
            .executeTakeFirst();
        if (deleted.numDeletedRows < BigInt(batchSize)) break;
    }
};
