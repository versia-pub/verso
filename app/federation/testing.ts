import type { Context } from "../kernel/context.ts";
import { DeliverJob, deliverQueue, deliveryBody } from "./deliver.ts";

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

/** The deliveries queued, in the order they were queued, each with the entity it sends. */
export const queuedDeliveries = async (
    ctx: Context,
): Promise<{ domain: string; body: string }[]> => {
    const jobs = await ctx.db.selectFrom("jobs").select(["payload", "created_at"])
        .where("queue", "=", deliverQueue).orderBy("id").execute();

    return await Promise.all(jobs.map(async (job) => {
        const payload = DeliverJob.parse(job.payload);
        const entity = await deliveryBody(ctx, payload, job.created_at);
        if (!entity) throw new Error("A queued delivery's entity is missing");
        return { domain: payload.domain, body: entity.body };
    }));
};
