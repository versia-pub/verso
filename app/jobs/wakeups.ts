import { getLogger } from "@logtape/logtape";
import pg from "pg";
import type { Config } from "../kernel/config.ts";

/** The Postgres channel `enqueue` notifies with the job's queue name. */
export const jobsChannel = "verso_jobs";

/**
 * Listens for newly enqueued jobs on a dedicated Postgres connection and fires an event named after
 * each job's queue, so idle workers can start at once instead of on their next poll. Returns
 * `undefined` on SQLite, where workers only poll, or when it can't connect. If the connection fails
 * later, workers fall back to polling too.
 */
export const listenForJobs = async (
    config: Config["database"],
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
        await client.end().catch(() => {});
        return undefined;
    }

    return Object.assign(events, { [Symbol.asyncDispose]: () => client.end() });
};
