import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { DeliverJob, deliverQueue, deliveryBody, fanOutQueue } from "./deliver.ts";

/** Stores `body` as an entity queued now, and returns a delivery of it to `domain`. */
export const deliveryOf = async (
    ctx: Context,
    domain: string,
    body: string,
): Promise<DeliverJob> => {
    const bodyId = ctx.ids();
    await ctx.db.insertInto("delivery_bodies")
        .values({ id: bodyId, body, created_at: ctx.clock.now() })
        .execute();

    return { domain, bodyId };
};

/** Runs the fan-out jobs queued, which queue deliveries, as a worker would. */
export const fanOut = async (ctx: Context): Promise<number> =>
    await drain(ctx, { [fanOutQueue]: queues[fanOutQueue] });

/**
 * The deliveries queued, in the order they were queued, each with the entity it sends, once the
 * fan-out jobs queued have run. Those of an entity deleted since, whose body was dropped, are left
 * out, as the worker doesn't send them.
 */
export const queuedDeliveries = async (
    ctx: Context,
): Promise<{ domain: string; body: string }[]> => {
    await fanOut(ctx);

    const jobs = await ctx.db.selectFrom("jobs").select(["payload", "created_at"])
        .where("queue", "=", deliverQueue).orderBy("run_at").orderBy("id").execute();

    const deliveries = [];
    for (const job of jobs) {
        const payload = DeliverJob.parse(job.payload);
        const entity = await deliveryBody(ctx, payload, job.created_at);
        if (entity) deliveries.push({ domain: payload.domain, body: entity.body });
    }

    return deliveries;
};

/** An entity as a plain object, before it is sent. */
type Entity = Record<string, unknown>;

/** A Versia `User` entity named `id`, as a remote instance sends it. */
export const userEntity = (id: string, more: Entity = {}): Entity => ({
    type: "User",
    id,
    created_at: "2026-10-18T12:00:00Z",
    username: id,
    manually_approves_subscribers: false,
    indexable: true,
    ...more,
});

/** A Versia `Delete` entity for the reference `deleted`, a `User` unless `more` says otherwise. */
export const deleteEntity = (deleted: string, more: Entity = {}): Entity => ({
    type: "Delete",
    created_at: "2026-10-18T12:00:00Z",
    deleted_type: "User",
    deleted,
    ...more,
});
