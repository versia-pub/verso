/**
 * Telling the rest of Verso what a service did, so a new side effect is one subscriber rather than
 * an edit inside the service.
 * @module
 */
import type { Context, DomainEvent } from "./context.ts";

/**
 * Tells every subscriber of `event`, in turn. It must be inside the transaction that made the
 * change, so the jobs subscribers enqueue commit with it: alone, they could outlive it or be lost.
 */
export const emit = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!ctx.db.isTransaction) throw new Error(`${event.type} was emitted outside a transaction`);

    for (const subscriber of ctx.subscribers) await subscriber(ctx, event);
};
