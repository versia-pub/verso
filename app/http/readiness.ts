import { getLogger } from "@logtape/logtape";
import { sql } from "kysely";
import type { Context } from "../kernel/context.ts";

/** How long the database has to answer, in milliseconds, well under a pool's connect timeout. */
const answerMs = 3000;

/**
 * What keeps this process from serving, if anything: `database` if the database doesn't answer in
 * time, or `pubsub` if the process doesn't hear other processes' messages, as `listening` says, so
 * that what it caches, such as blocked domains, may be stale. The reason is logged, not returned,
 * since a database error can name its host.
 */
export const unready = async (
    ctx: Context,
    listening: () => boolean,
    timeoutMs: number = answerMs,
): Promise<"database" | "pubsub" | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`It didn't answer in ${timeoutMs} ms`)),
            timeoutMs,
        );
    });

    try {
        await Promise.race([sql`select 1`.execute(ctx.db), timedOut]);
    } catch (error) {
        getLogger(["verso", "http"]).warn("The database isn't ready: {error}", { error });
        return "database";
    } finally {
        clearTimeout(timer);
    }

    return listening() ? undefined : "pubsub";
};
