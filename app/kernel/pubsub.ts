/**
 * Messages between Verso's processes, such as to tell every web node that a cache is stale. Each
 * message is sent once what published it commits, and heard by every subscriber of its channel, in
 * every process, the one that sent it included.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import type { z } from "zod";
import type { Context, Handler, PubSub } from "./context.ts";

/** A kind of message, by its name and what it holds. */
export type Channel<T> = {
    readonly name: string;
    /** Checks what is heard, since it may come from a process running another version of Verso. */
    readonly schema: z.ZodType<T>;
};

/** The subscribers of each channel, as adapters keep them. */
export type Routes = Pick<PubSub, "subscribe"> & {
    /** Gives `payload` to each subscriber of `channel`, logging rather than throwing if any fails. */
    readonly deliver: (channel: string, payload: string) => Promise<void>;
};

const logger = getLogger(["verso", "pubsub"]);

/** No subscribers yet, for an adapter to give what it hears to. */
export const routes = (): Routes => {
    const handlers = new Map<string, Set<Handler>>();

    return {
        subscribe: (channel, handler) => {
            const subscribed = handlers.get(channel) ?? new Set();
            handlers.set(channel, subscribed);

            subscribed.add(handler);

            return () => {
                subscribed.delete(handler);
            };
        },
        deliver: async (channel, payload) => {
            await Promise.all([...handlers.get(channel) ?? []].map(async (handler) => {
                try {
                    await handler(payload);
                } catch (error) {
                    logger.error("Failed on a message on {channel}: {error}", { channel, error });
                }
            }));
        },
    };
};

/**
 * Sends messages to this process only, for tests and SQLite, which only one process can use well.
 * Sending resolves once every subscriber has handled the message.
 */
export const memoryPubSub = (): PubSub => {
    const subscribed = routes();
    return { send: subscribed.deliver, subscribe: subscribed.subscribe };
};

/**
 * Sends `message` on `channel` once the current transaction commits, or at once outside one. It
 * isn't sent if the transaction rolls back.
 */
export const publish = <T>(ctx: Context, channel: Channel<T>, message: T): Promise<void> =>
    ctx.afterCommit(() => ctx.pubsub.send(channel.name, JSON.stringify(message)));

/**
 * Gives `handler` each message sent on `channel` from now on, until the function returned is
 * called. Messages that aren't JSON, or don't match the channel's schema, are logged and skipped.
 */
export const subscribe = <T>(
    ctx: Context,
    channel: Channel<T>,
    handler: (message: T) => Promise<void>,
): () => void =>
    ctx.pubsub.subscribe(channel.name, async (payload) => {
        const parsed = channel.schema.safeParse(JSON.parse(payload));
        if (!parsed.success) {
            logger.warning("Skipped a message on {channel} that isn't one: {payload}", {
                channel: channel.name,
                payload,
            });
            return;
        }

        await handler(parsed.data);
    });
