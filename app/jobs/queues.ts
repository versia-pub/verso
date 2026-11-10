import {
    accountPruneHandler,
    accountPruneQueue,
    accountPruneStartQueue,
    startAccountPruning,
} from "../accounts/pruning.ts";
import { announcementsQueue, publishDueAnnouncements } from "../announcements/announcements.ts";
import { deleteExpiredFlows } from "../auth/flow_queries.ts";
import { acceptHandler, acceptQueue } from "../graph/follows.ts";
import {
    deleteExpiredDeliveryBodies,
    deliverQueue,
    fanOutDeadPayload,
    fanOutHandler,
    fanOutQueue,
} from "../federation/deliver.ts";
import { deliverDeadPayload, deliverHandler } from "../federation/deliver_worker.ts";
import { inboxQueue } from "../federation/inbox.ts";
import {
    resanitiseHandler,
    resanitiseQueue,
    resanitiseStartQueue,
    startResanitising,
} from "../federation/resanitising.ts";
import { undoneReactionsHandler, undoneReactionsQueue } from "../interactions/reactions.ts";
import { inboxDeadPayload, inboxHandler } from "../federation/inbox_worker.ts";
import { messageHandler, messageQueue } from "../federation/messaging.ts";
import { deleteEndedRateLimits } from "../http/rate_limit_queries.ts";
import { removeUnusedMedia, unusedMediaQueue } from "../media/cleanup.ts";
import { mediaHandler } from "../media/processing.ts";
import { mediaQueue } from "../media/uploads.ts";
import { pruneHandler, pruneQueue, pruneStartQueue, startPruning } from "../notes/pruning.ts";
import { totalsHandler, totalsQueue } from "../notes/totals.ts";
import { notifyHandler, notifyQueue } from "../notifications/notifications.ts";
import { endedPollsQueue, endPolls } from "../polls/ending.ts";
import { pollRefreshHandler, pollRefreshQueue } from "../polls/refreshing.ts";
import { pollUpdateHandler, pollUpdatesQueue } from "../polls/updating.ts";
import { cardHandler, cardsQueue } from "../previews/cards.ts";
import { pushHandler, pushQueue } from "../push/pushes.ts";
import { registry } from "../registry.ts";
import { publishDue, scheduledNotesQueue } from "../schedules/publishing.ts";
import { refreshTrends, trendsQueue } from "../trends/refresh.ts";
import { deleteExpiredJobs } from "./job_queries.ts";
import type { Task } from "./scheduler.ts";
import type { Queue } from "./worker.ts";

/** Work the scheduler enqueues every hour, each in its own queue, one job at a time. */
const hourly: Record<string, Queue["handler"]> = {
    "jobs-cleanup": (ctx) => deleteExpiredJobs(ctx),
    "delivery-bodies-cleanup": (ctx) => deleteExpiredDeliveryBodies(ctx),
    "oauth-cleanup": (ctx) => deleteExpiredFlows(ctx),
    "rate-limits-cleanup": (ctx) => deleteEndedRateLimits(ctx),
    [unusedMediaQueue]: (ctx) => removeUnusedMedia(ctx),
    [resanitiseStartQueue]: (ctx) => startResanitising(ctx),
};

/** Work the scheduler enqueues every day, as `hourly` is every hour. */
const daily: Record<string, Queue["handler"]> = {
    [pruneStartQueue]: (ctx) => startPruning(ctx),
    [accountPruneStartQueue]: (ctx) => startAccountPruning(ctx),
};

/** Work the scheduler enqueues every minute, as `hourly` is every hour. */
const everyMinute: Record<string, Queue["handler"]> = {
    [announcementsQueue]: (ctx) => publishDueAnnouncements(ctx),
    [endedPollsQueue]: (ctx) => endPolls(ctx),
    [scheduledNotesQueue]: (ctx) => publishDue(ctx),
    [trendsQueue]: (ctx) => refreshTrends(ctx),
};

/** Every queue the worker runs, by name. Modules add theirs as they need them. */
export const queues: Record<string, Queue> = {
    [inboxQueue]: {
        handler: inboxHandler(registry),
        concurrency: 4,
        deadPayload: inboxDeadPayload,
    },
    // One at a time, so entities are queued for delivery in the order they were sent.
    [fanOutQueue]: { handler: fanOutHandler, concurrency: 1, deadPayload: fanOutDeadPayload },
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
    [pollUpdatesQueue]: { handler: pollUpdateHandler, concurrency: 2 },
    // By the poll's instance.
    [pollRefreshQueue]: { handler: pollRefreshHandler, concurrency: 4, perGroup: 2 },
    // Each job fetches a page and an image, and runs vips on the image.
    [cardsQueue]: { handler: cardHandler, concurrency: 2 },
    // By the push service's host.
    [pushQueue]: { handler: pushHandler, concurrency: 8, perGroup: 2 },
    // Each job runs vips a few times, a minute each at most, and uses memory while it does.
    [mediaQueue]: { handler: mediaHandler, concurrency: 2, leaseMs: 15 * 60_000 },
    // One at a time, so each version's work goes through the rows in order, once.
    [resanitiseQueue]: { handler: resanitiseHandler, concurrency: 1 },
    // One at a time, so each pass goes through the statuses, or accounts, in order, once.
    [pruneQueue]: { handler: pruneHandler, concurrency: 1 },
    [accountPruneQueue]: { handler: accountPruneHandler, concurrency: 1 },
    ...Object.fromEntries(
        Object.entries({ ...daily, ...hourly, ...everyMinute })
            .map(([queue, handler]) => [queue, { handler, concurrency: 1 }]),
    ),
};

/** Recurring work the scheduler enqueues. */
export const tasks: readonly Task[] = [
    ...Object.keys(daily).map((queue): Task => ({ queue, every: "day" })),
    ...Object.keys(hourly).map((queue): Task => ({ queue, every: "hour" })),
    ...Object.keys(everyMinute).map((queue): Task => ({ queue, every: "minute" })),
];
