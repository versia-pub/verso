import { getLogger } from "@logtape/logtape";
import pg from "pg";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { type Channel, subscribe } from "../kernel/pubsub.ts";

/** The Postgres channel `enqueue` notifies with the job's queue name. */
export const jobsChannel = "verso_jobs";

/** What `enqueue` sends on SQLite, where Postgres notifications don't exist: the job's queue. */
export const jobWakeups: Channel<string> = { name: "job-wakeups", schema: z.string() };

/**
 * Listens for newly enqueued jobs on a dedicated Postgres connection and fires an event named after
 * each job's queue, so idle workers can start immediately instead of on their next poll. Returns
 * `undefined` on SQLite, whose workers hear {@link jobWakeups} instead, or when it can't connect. If
 * the connection fails later, workers fall back to polling.
 */
export const listenForJobs = async (
    config: { readonly postgres: string } | { readonly sqlite: string },
): Promise<(EventTarget & AsyncDisposable) | undefined> => {
    if (!("postgres" in config)) return undefined;

    const logger = getLogger(["verso", "jobs"]);
    const events = new EventTarget();
    const client = new pg.Client({ connectionString: config.postgres });

    client.on("notification", ({ payload }) => {
        if (payload) events.dispatchEvent(new Event(payload));
    });
    client.on("error", (error) => {
        logger.error("Stopped listening for new jobs, so workers only poll: {error}", { error });
    });

    try {
        await client.connect();
        await client.query(`listen ${jobsChannel}`);
    } catch (error) {
        logger.warning("Couldn't listen for new jobs, so workers only poll: {error}", { error });
        await client.end().catch((error) => {
            logger.debug("Couldn't close the connection that failed: {error}", { error });
        });
        return undefined;
    }

    return Object.assign(events, { [Symbol.asyncDispose]: () => client.end() });
};

/**
 * Like {@link listenForJobs}, but for the messages `enqueue` sends on SQLite, whose workers run in
 * the process that enqueues.
 */
export const hearJobWakeups = (ctx: Context): EventTarget & AsyncDisposable => {
    const events = new EventTarget();
    const unsubscribe = subscribe(ctx, jobWakeups, (queue) => {
        events.dispatchEvent(new Event(queue));
        return Promise.resolve();
    });

    return Object.assign(events, {
        [Symbol.asyncDispose]: () => Promise.resolve(unsubscribe()),
    });
};
