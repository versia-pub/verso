/**
 * `verso admin jobs …`.
 * @module
 */
import { Command, ValidationError } from "@cliffy/command";
import {
    deadLetterQueues,
    type DeadSelection,
    deleteDeadLetters,
    listDeadLetters,
    queueStats,
    retryDeadLetters,
} from "../jobs/job_queries.ts";
import { queues } from "../jobs/queues.ts";
import type { Context } from "../kernel/context.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The dead letters given as ids or `--queue`, one or the other. */
const selectionOf = (ids: readonly string[], queue: string | undefined): DeadSelection => {
    if (ids.length > 0 && queue !== undefined) {
        throw new ValidationError("Give job ids or --queue, not both");
    }
    if (queue !== undefined) return { queue };
    if (ids.length === 0) throw new ValidationError("Give job ids or --queue");

    return { ids };
};

/**
 * Why the dead letters of `queue` can't run again, if they can't: the worker doesn't run it, or
 * they keep only a summary of their payload, like deliveries do.
 */
const whyNotRetried = (queue: string): string | undefined => {
    const runs = Object.hasOwn(queues, queue) ? queues[queue] : undefined;
    if (!runs) return `${queue} isn't a queue Verso runs`;
    if (runs.deadPayload) {
        return `${queue}'s dead letters keep only a summary of their payload, so they can't be ` +
            "retried";
    }

    return undefined;
};

/** Refuses to retry dead letters that can't be, or ids that aren't dead letters. */
const checkRetryable = async (ctx: Context, selection: DeadSelection) => {
    if ("queue" in selection) {
        const why = whyNotRetried(selection.queue);
        if (why) throw new AdminError(why);
        return;
    }

    const found = await deadLetterQueues(ctx, selection);
    const missing = selection.ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new AdminError(`Not dead letters: ${missing.join(", ")}`);

    for (const queue of new Set(found.values())) {
        const why = whyNotRetried(queue);
        if (why) throw new AdminError(why);
    }
};

/** The `jobs` group of commands. */
export const jobsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description(
            "See the work Verso has queued, and run again or delete the jobs that failed for good, " +
                "its dead letters.",
        )
        .action(missingCommand)
        .command(
            "list",
            "Print each queue with jobs: how many wait, when the one due longest became due, and " +
                "how many are dead letters.",
        )
        .action(async ({ config }) => {
            const stats = await io.withContext(config, (ctx) => queueStats(ctx, ctx.clock.now()));
            io.print(JSON.stringify(stats.map((stat) => ({
                queue: stat.queue,
                waiting: stat.waiting,
                oldest_due: stat.oldestDue ?? null,
                dead: stat.dead,
            }))));
        })
        .command("dead", "Print the dead letters that died last, with why.")
        .option("--queue <queue:string>", "Only this queue's.")
        .option("--limit <limit:integer>", "How many.", { default: 20 })
        .action(async ({ config, queue, limit }) => {
            if (limit < 1) throw new AdminError("--limit must be at least 1");

            const dead = await io.withContext(
                config,
                (ctx) => listDeadLetters(ctx, { queue, limit }),
            );
            io.print(JSON.stringify(dead));
        })
        .command(
            "retry [...ids:string]",
            "Run dead letters again, with their attempts started over: those given, or a " +
                "queue's. Workers pick them up on their next poll.",
        )
        .option("--queue <queue:string>", "Every dead letter of this queue.")
        .action(async ({ config, queue }, ...ids) => {
            const selection = selectionOf(ids, queue);
            const retried = await io.withContext(config, async (ctx) => {
                await checkRetryable(ctx, selection);
                return await retryDeadLetters(ctx, selection);
            });
            io.print(JSON.stringify({ retried }));
        })
        .command("purge [...ids:string]", "Delete dead letters: those given, or a queue's.")
        .option("--queue <queue:string>", "Every dead letter of this queue.")
        .action(async ({ config, queue }, ...ids) => {
            const selection = selectionOf(ids, queue);
            const deleted = await io.withContext(
                config,
                (ctx) => deleteDeadLetters(ctx, selection),
            );
            io.print(JSON.stringify({ deleted }));
        })
        .reset();
