/**
 * Sending entities to remote Versia instances. The entity is stored once, and one fan-out job finds
 * the instances to send it to, outside the request, then queues one delivery job per instance for
 * the delivery worker, each referring to the entity.
 * @see https://versia.pub/federation/http
 * @module
 */
import type { SelectQueryBuilder } from "kysely";
import { z } from "zod";
import type { Database } from "../db/database.ts";
import { batchesOf } from "../db/batches.ts";
import { instancesHosting } from "../accounts/account_queries.ts";
import { followerInstances } from "../graph/follows.ts";
import { allInstanceIds, reachableDomainsOf } from "../instances/instance_queries.ts";
import { type DeadPayload, enqueue, enqueueAll } from "../jobs/job_queries.ts";
import type { JobPayload, JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { byRemovedUser, bySuspendedUser } from "./authors.ts";

/** Versia's own queue, so deliveries of other protocols can't hold it up. */
export const deliverQueue = "versia-deliver";

/** The queue of fan-out jobs, which each queue an entity's deliveries. */
export const fanOutQueue = "versia-fan-out";

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

/** The payload of a fan-out job. */
export const FanOutJob = z.object({
    /** The entity's row in `delivery_bodies`. */
    bodyId: z.string(),
    /** The instances to send it to, by id. */
    instanceIds: z.array(z.string()),
    /** An account whose followers' instances are sent it too, found when the job runs. */
    followersOf: z.string().optional(),
    /** Whether the followers that account blocks are left out, as for its followers-only statuses. */
    unblockedFollowers: z.boolean().optional(),
    /** Whether every instance Verso knows is sent it, as they are when the job runs. */
    everyInstance: z.boolean().optional(),
});
export type FanOutJob = z.infer<typeof FanOutJob>;

/** What a fan-out job stores once it dies: the entity, without the instances it was for. */
export const fanOutDeadPayload: DeadPayload = (payload: JobPayload): JobPayload => {
    const job = FanOutJob.safeParse(payload);
    return job.success ? { bodyId: job.data.bodyId } : {};
};

/**
 * More than are ever made: deliveries are given up on by age, after as long as the settings say (at
 * most 30 days), with at most six hours between attempts.
 */
const maxAttempts = 1000;

/** Where an entity is sent. */
export type Audience = {
    /** Instances, by id. */
    readonly instanceIds: readonly string[];
    /** An account, whose followers' instances are sent it too, as they are when it is sent. */
    readonly followersOf?: string;
    /**
     * Whether the followers that account blocks, individually or by their domain, are left out, so
     * that its followers-only statuses don't reach an instance only they follow it from.
     */
    readonly unblockedFollowers?: boolean;
    /** Whether every instance Verso knows is sent it, as they are when it is sent. */
    readonly everyInstance?: boolean;
};

/**
 * Queues `entity` for delivery to its audience. Only the entity and one fan-out job are written
 * here, so sending costs the same however many followers are in the audience: the job finds their
 * instances, and queues the deliveries.
 */
export const queueDeliveriesTo = async (
    ctx: Context,
    entity: object,
    audience: Audience,
): Promise<void> => {
    const { instanceIds, followersOf, unblockedFollowers, everyInstance } = audience;
    if (instanceIds.length === 0 && followersOf === undefined && everyInstance !== true) return;

    // Stored once, however many instances it goes to.
    const bodyId = ctx.ids();
    await ctx.db.insertInto("delivery_bodies")
        .values({ id: bodyId, body: JSON.stringify(entity), created_at: ctx.clock.now() })
        .execute();

    const payload: FanOutJob = { bodyId, instanceIds: [...instanceIds] };
    if (followersOf !== undefined) payload.followersOf = followersOf;
    if (unblockedFollowers === true) payload.unblockedFollowers = true;
    if (everyInstance === true) payload.everyInstance = true;
    await enqueue(ctx, { queue: fanOutQueue, payload });
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
): Promise<void> =>
    await queueDeliveriesTo(ctx, entity, { instanceIds: await instancesHosting(ctx, recipients) });

/**
 * The instances in an audience, by id, in order, with those of the followers it names, or every
 * instance if it says so.
 */
export const audienceInstances = async (ctx: Context, audience: Audience): Promise<string[]> => {
    if (audience.everyInstance === true) return (await allInstanceIds(ctx)).toSorted();

    const followers = audience.followersOf === undefined
        ? []
        : await followerInstances(ctx, audience.followersOf, audience.unblockedFollowers);

    return [...new Set([...audience.instanceIds, ...followers])].toSorted();
};

/**
 * The domains a fan-out job sends to: each of its instances that is a Versia instance, and isn't
 * blocked, nor couldn't be reached for as long as the settings say, as on Mastodon, until it is
 * heard from again.
 */
const domainsOf = async (ctx: Context, job: FanOutJob) => {
    const ids = await audienceInstances(ctx, job);
    const before = new Date(ctx.clock.now().getTime() - ctx.settings.unreachableMs);

    const domains = [];
    for (const batch of batchesOf(ids)) {
        for (const domain of await reachableDomainsOf(ctx, batch, "versia", before)) {
            if (!await ctx.federation.isBlocked(ctx, domain)) domains.push(domain);
        }
    }

    return domains;
};

/**
 * Whether the entity stored as `bodyId` is by a local user suspended or removed since, and isn't a
 * Delete.
 */
const withheld = async (ctx: Context, bodyId: string) => {
    const row = await ctx.db.selectFrom("delivery_bodies").select("body").where("id", "=", bodyId)
        .executeTakeFirst();
    if (row === undefined) return false;

    const entity: unknown = JSON.parse(row.body);
    if ((entity as { type?: unknown }).type === "Delete") return false;

    return await bySuspendedUser(ctx, entity, ctx.urls.domain) ||
        await byRemovedUser(ctx, entity);
};

/**
 * Runs fan-out jobs: queues a delivery of the entity to each instance it goes to, grouped by
 * instance so each can be rate limited, or deletes the entity if it goes to none, or is by a
 * suspended or removed user, unless it deletes something. A job run again
 * doesn't queue a delivery that is still queued, but may queue one that was already sent again.
 * The deliveries are due when the job was queued, so the entities queued earlier are sent first.
 */
export const fanOutHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = FanOutJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a fan-out job");
    const { bodyId } = payload.data;

    const domains = await withheld(ctx, bodyId) ? [] : await domainsOf(ctx, payload.data);

    await ctx.transaction(async (tx) => {
        if (domains.length === 0) {
            await tx.db.deleteFrom("delivery_bodies").where("id", "=", bodyId).execute();
            return;
        }

        await enqueueAll(
            tx,
            domains.map((domain) => ({
                queue: deliverQueue,
                payload: { domain, bodyId } satisfies DeliverJob,
                runAt: job.created_at,
                maxAttempts,
                dedupeKey: `${deliverQueue}:${bodyId}:${domain}`,
                group: domain,
                // Deliveries are numerous, so workers find them by polling.
                wake: false,
            })),
        );
    });
};

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
