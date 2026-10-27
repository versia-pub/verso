import { getLogger } from "@logtape/logtape";
import type { Kysely } from "kysely";
import pg from "pg";
import { z } from "zod";
import type { PubSub } from "../kernel/context.ts";
import { routes } from "../kernel/pubsub.ts";
import { notify } from "./notify.ts";

/** The Postgres channel every message is sent on, with Verso's channel inside it. */
export const messagesChannel = "verso_messages";

/** A notification on {@link messagesChannel}: Verso's channel, and the message. */
const Envelope = z.tuple([z.string(), z.string()]);

/** Sends messages between processes through Postgres, and hears them once it listens. */
export type PostgresPubSub = PubSub & AsyncDisposable & {
    /**
     * Listens for messages on a dedicated connection, if it isn't already, and resolves with
     * whether it does at first. Subscribing starts it, so a process that only sends never listens.
     */
    readonly listen: () => Promise<boolean>;
};

/** How long to wait before listening again, at first, and at most, in milliseconds. */
const retryMs = { first: 1000, most: 30_000 };

/**
 * Sends messages with `pg_notify` on `db`, which must not be a transaction, since messages are sent
 * after one commits, and hears them on a connection of its own to `url`. If it can't listen, or
 * the connection drops, that is logged, and it tries again, waiting twice as long each time up to
 * half a minute, then tells `onMissed` handlers, since it heard nothing meanwhile.
 */
export const postgresPubSub = <DB>(
    db: Kysely<DB>,
    url: string,
    options: { readonly firstRetryMs?: number } = {},
): PostgresPubSub => {
    const logger = getLogger(["verso", "pubsub"]);
    const subscribed = routes();

    let client: pg.Client | undefined;
    let connecting: Promise<boolean> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    /** Waits `delayMs`, then listens again, or else waits longer, until disposed. */
    const retryIn = (delayMs: number) => {
        if (disposed) return;

        retry = setTimeout(async () => {
            retry = undefined;
            if (!await (connecting = connect())) {
                return retryIn(Math.min(delayMs * 2, retryMs.most));
            }

            logger.info("Hearing other processes' messages again");
            await subscribed.missed();
        }, delayMs);
    };

    /** Listens on a new connection, and resolves with whether it does. */
    const connect = async () => {
        const listener = new pg.Client({ connectionString: url });

        listener.on("notification", ({ payload }) => {
            let heard: z.infer<typeof Envelope>;
            try {
                heard = Envelope.parse(JSON.parse(payload ?? ""));
            } catch {
                logger.warning("Skipped a notification that isn't a message: {payload}", {
                    payload,
                });
                return;
            }

            void subscribed.deliver(...heard);
        });
        listener.on("error", (error) => {
            logger.error("Stopped hearing other processes' messages: {error}", { error });
        });
        listener.on("end", () => {
            if (client !== listener) return;

            client = undefined;
            retryIn(options.firstRetryMs ?? retryMs.first);
        });

        try {
            await listener.connect();
            await listener.query(`listen ${messagesChannel}`);
        } catch (error) {
            logger.warning("Couldn't hear other processes' messages: {error}", { error });
            await listener.end().catch(() => {});
            return false;
        }

        client = listener;
        return true;
    };

    let listening: Promise<boolean> | undefined;
    const listen = () =>
        listening ??= (connecting = connect()).then((connected) => {
            if (!connected) retryIn(options.firstRetryMs ?? retryMs.first);
            return connected;
        });

    return {
        send: (channel, payload) => notify(db, messagesChannel, JSON.stringify([channel, payload])),
        subscribe: (channel, handler) => {
            void listen();
            return subscribed.subscribe(channel, handler);
        },
        onMissed: subscribed.onMissed,
        listen,
        [Symbol.asyncDispose]: async () => {
            disposed = true;
            clearTimeout(retry);
            await connecting;
            await client?.end();
        },
    };
};
