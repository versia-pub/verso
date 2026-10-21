import { deleteExpiredFlows } from "../auth/flows.ts";
import { acceptHandler, acceptQueue } from "../graph/follows.ts";
import { deliverQueue } from "../federation/deliver.ts";
import { deliverHandler } from "../federation/deliver_worker.ts";
import { inboxQueue } from "../federation/inbox.ts";
import { inboxHandler } from "../federation/inbox_worker.ts";
import { deleteEndedRateLimits } from "../http/rate_limits.ts";
import { registry } from "../registry.ts";
import { deleteExpiredJobs } from "./queue.ts";
import type { Task } from "./scheduler.ts";
import type { Queue } from "./worker.ts";

/** Every queue the worker runs, by name. Modules add theirs as they need them. */
export const queues: Record<string, Queue> = {
    [inboxQueue]: { handler: inboxHandler(registry), concurrency: 4 },
    [deliverQueue]: { handler: deliverHandler, concurrency: 8, perGroup: 2 },
    [acceptQueue]: { handler: acceptHandler, concurrency: 2 },
    "jobs-cleanup": { handler: (ctx) => deleteExpiredJobs(ctx), concurrency: 1 },
    "oauth-cleanup": { handler: (ctx) => deleteExpiredFlows(ctx), concurrency: 1 },
    "rate-limits-cleanup": { handler: (ctx) => deleteEndedRateLimits(ctx), concurrency: 1 },
};

/** Recurring work the scheduler enqueues. */
export const tasks: readonly Task[] = [
    { queue: "jobs-cleanup", every: "hour" },
    { queue: "oauth-cleanup", every: "hour" },
    { queue: "rate-limits-cleanup", every: "hour" },
];
