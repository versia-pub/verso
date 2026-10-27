/**
 * Keeping each process's cached instance key and blocked domains up to date when one changes them.
 * @module
 */
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { type Channel, publish, subscribe } from "../kernel/pubsub.ts";

/** Says the instance's key or the blocked domains changed. */
const changed: Channel<Record<string, never>> = {
    name: "federation.changed",
    schema: z.strictObject({}),
};

/**
 * Clears the cached instance key and blocked domains in every process once the current transaction
 * commits, or at once outside one, so changing them applies everywhere. A process that can't hear
 * other processes' messages reads them again within a minute.
 */
export const forgetEverywhere = async (ctx: Context): Promise<void> => {
    // Without waiting to hear its own message, but not before the commit, so that it doesn't read
    // and keep the old values in the meantime.
    await ctx.afterCommit(() => Promise.resolve(ctx.federation.forget()));
    await publish(ctx, changed, {});
};

/** Clears this process's caches whenever any process changes what they hold, until called. */
export const forgetWhenTold = (ctx: Context): () => void =>
    subscribe(ctx, changed, () => Promise.resolve(ctx.federation.forget()));
