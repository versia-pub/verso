import { deleteExpiredFlows } from "../auth/flows.ts";
import { deleteEndedRateLimits } from "../http/rate_limits.ts";
import { deleteExpiredJobs } from "./queue.ts";
import type { Task } from "./scheduler.ts";
import type { Queue } from "./worker.ts";

/** Every queue the worker runs, by name. Modules add theirs as they need them. */
export const queues: Record<string, Queue> = {
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
