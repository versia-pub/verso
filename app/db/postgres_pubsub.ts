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
     * whether it does. Subscribing starts it, so a process that only sends never listens.
     */
    readonly listen: () => Promise<boolean>;
};

/**
 * Sends messages with `pg_notify` on `db`, which must not be a transaction, since messages are sent
 * after one commits, and hears them on a connection of its own to `url`. If it can't listen, or
 * stops, that is logged, and this process hears nothing.
 */
export const postgresPubSub = <DB>(db: Kysely<DB>, url: string): PostgresPubSub => {
    const logger = getLogger(["verso", "pubsub"]);
    const subscribed = routes();

    const connect = async () => {
        const client = new pg.Client({ connectionString: url });

        client.on("notification", ({ payload }) => {
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
        client.on("error", (error) => {
            logger.error("Stopped hearing other processes' messages: {error}", { error });
        });

        try {
            await client.connect();
            await client.query(`listen ${messagesChannel}`);
            return client;
        } catch (error) {
            logger.warning("Couldn't hear other processes' messages: {error}", { error });
            await client.end().catch(() => {});
            return undefined;
        }
    };

    let listening: Promise<pg.Client | undefined> | undefined;
    const listen = async () => (await (listening ??= connect())) !== undefined;

    return {
        send: (channel, payload) => notify(db, messagesChannel, JSON.stringify([channel, payload])),
        subscribe: (channel, handler) => {
            void listen();
            return subscribed.subscribe(channel, handler);
        },
        listen,
        [Symbol.asyncDispose]: async () => {
            await (await listening)?.end();
        },
    };
};
