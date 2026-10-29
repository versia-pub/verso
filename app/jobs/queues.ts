import { deleteExpiredFlows } from "../auth/flow_queries.ts";
import { acceptHandler, acceptQueue } from "../graph/follows.ts";
import { deliverQueue } from "../federation/deliver.ts";
import { deliverDeadPayload, deliverHandler } from "../federation/deliver_worker.ts";
import { inboxQueue } from "../federation/inbox.ts";
import { undoneReactionsHandler, undoneReactionsQueue } from "../interactions/reactions.ts";
import { inboxDeadPayload, inboxHandler } from "../federation/inbox_worker.ts";
import { messageHandler, messageQueue } from "../federation/messaging.ts";
import { deleteEndedRateLimits } from "../http/rate_limit_queries.ts";
import { mediaHandler, mediaQueue, removeUnusedMedia, unusedMediaQueue } from "../media/uploads.ts";
import { totalsHandler, totalsQueue } from "../notes/totals.ts";
import { notifyHandler, notifyQueue } from "../notifications/notifications.ts";
import { pushHandler, pushQueue } from "../push/pushes.ts";
import { registry } from "../registry.ts";
import { deleteExpiredJobs } from "./job_queries.ts";
import type { Task } from "./scheduler.ts";
import type { Queue } from "./worker.ts";

/** Work the scheduler enqueues every hour, each in its own queue, one job at a time. */
const hourly: Record<string, Queue["handler"]> = {
    "jobs-cleanup": (ctx) => deleteExpiredJobs(ctx),
    "oauth-cleanup": (ctx) => deleteExpiredFlows(ctx),
    "rate-limits-cleanup": (ctx) => deleteEndedRateLimits(ctx),
    [unusedMediaQueue]: (ctx) => removeUnusedMedia(ctx),
};

/** Every queue the worker runs, by name. Modules add theirs as they need them. */
export const queues: Record<string, Queue> = {
    [inboxQueue]: {
        handler: inboxHandler(registry),
        concurrency: 4,
        deadPayload: inboxDeadPayload,
    },
    [deliverQueue]: {
        handler: deliverHandler,
        concurrency: 8,
        perGroup: 2,
        deadPayload: deliverDeadPayload,
    },
    [messageQueue]: { handler: messageHandler, concurrency: 2, perGroup: 1 },
    [acceptQueue]: { handler: acceptHandler, concurrency: 2 },
    [undoneReactionsQueue]: { handler: undoneReactionsHandler, concurrency: 2 },
    [notifyQueue]: { handler: notifyHandler, concurrency: 2 },
    [totalsQueue]: { handler: totalsHandler, concurrency: 4, perGroup: 2 },
    // By the push service's host.
    [pushQueue]: { handler: pushHandler, concurrency: 8, perGroup: 2 },
    // Each job runs vips a few times, a minute each at most, and uses memory while it does.
    [mediaQueue]: { handler: mediaHandler, concurrency: 2, leaseMs: 15 * 60_000 },
    ...Object.fromEntries(
        Object.entries(hourly).map(([queue, handler]) => [queue, { handler, concurrency: 1 }]),
    ),
};

/** Recurring work the scheduler enqueues. */
export const tasks: readonly Task[] = Object.keys(hourly).map((queue) => ({
    queue,
    every: "hour",
}));
