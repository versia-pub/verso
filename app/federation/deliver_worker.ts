/**
 * The delivery worker, which sends queued entities to remote instances' inboxes.
 * @see https://versia.pub/federation/http
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { parkedUntil, recordReached, recordUnreachable } from "../instances/reachability.ts";
import type { DeadPayload } from "../jobs/job_queries.ts";
import { postponeGroup, resumeGroup } from "../jobs/job_pause_queries.ts";
import type { JobPayload, JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure, RetryAt } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { versiaUrl } from "../kernel/urls.ts";
import { DeliverJob, deliverQueue, deliveryBody } from "./deliver.ts";
import { type FederationReply, sendSigned, Unreachable } from "./request.ts";

const logger = getLogger(["verso", "federation"]);

/** When `Retry-After` says to retry, in seconds or as a date, if present. */
export const retryAfter = (headers: Headers, now: Date): Date | undefined => {
    const value = headers.get("retry-after");
    if (!value) return undefined;

    if (/^\d+$/.test(value)) return new Date(now.getTime() + Number(value) * 1000);

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * When an instance's rate limit allows requests again, if it says none are left, using
 * `RateLimit-Remaining` and `RateLimit-Reset` in seconds, as Verso sends them.
 */
export const rateLimitReset = (headers: Headers, now: Date): Date | undefined => {
    const reset = headers.get("ratelimit-reset");
    if (headers.get("ratelimit-remaining") !== "0" || !reset || !/^\d+$/.test(reset)) {
        return undefined;
    }

    return new Date(now.getTime() + Number(reset) * 1000);
};

/** What a delivery stores once it dies: the instance it was for, without the entity. */
export const deliverDeadPayload: DeadPayload = (payload: JobPayload): JobPayload => {
    const job = DeliverJob.safeParse(payload);
    return job.success ? { domain: job.data.domain } : {};
};

/**
 * Runs delivery jobs: signs each entity and posts it to the instance's inbox. If the instance
 * rejects it with a 4xx other than 408 and 429, the delivery is given up on. Any other failure is
 * retried, for as long as the settings say (two days by default), at the times the instance asks
 * for, if it does. A delivery to an instance blocked since is dropped. An instance that asks to
 * wait, or has no requests left, isn't sent any delivery until then, and nor is one that couldn't
 * be reached too often in a row, except for an occasional probe.
 *
 * How the pausing works, from the start:
 * 1. An instance that fails (`Unreachable` or a 5xx or 408 reply) is counted by
 *    `recordUnreachable`, which parks it after enough failures in a row (`reachability.ts`). While
 *    the park lasts, `parkedUntil` tells every delivery of the instance to wait. Once it is over,
 *    one delivery gets through as a probe while the others wait a minute.
 * 2. `postponeGroup` writes the instance's pause to `job_pauses` (`job_pause_queries.ts`), keyed by
 *    this queue and the domain, which is each delivery's group. The pause comes from the park, from
 *    `Retry-After` and from a rate limit with nothing left.
 * 3. `postponeGroup` also makes the instance's waiting deliveries due when the pause ends, and
 *    `enqueue` does the same for new ones, so claims don't read them meanwhile. `claim` skips any
 *    of the group's jobs due before then all the same, so its deliveries aren't leased at all. A delivery already leased, and so not skipped, does the same
 *    as the probe: `parkedUntil` makes it throw `RetryAt`, which only moves its own `run_at`.
 * 4. Any reply but a server failure is `recordReached`: if the instance had been failing or parked,
 *    `resumeGroup` deletes the pause and makes the waiting deliveries due now. Otherwise the pause
 *    just ends at its time, and the deliveries are claimed again.
 */
export const deliverHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = DeliverJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a delivery job");
    const { domain } = payload.data;

    if (await ctx.federation.isBlocked(ctx, domain)) {
        logger.info("Dropping a delivery to {domain}, since it is now blocked", { domain });
        return;
    }

    const tried = `${ctx.settings.deliveryMs / 3_600_000} hours`;
    const entity = await deliveryBody(ctx, payload.data, job.created_at);
    if (!entity) throw new PermanentFailure(`${domain} couldn't be reached in ${tried}`);
    const { body } = entity;

    // Given up on by the entity's age, which is when its deliveries were all queued.
    const now = ctx.clock.now();
    const giveUpAt = new Date(entity.queuedAt.getTime() + ctx.settings.deliveryMs);
    if (now >= giveUpAt) throw new PermanentFailure(`${domain} couldn't be reached in ${tried}`);

    const parked = await parkedUntil(ctx, domain);
    if (parked) {
        await postponeGroup(ctx, deliverQueue, domain, parked);
        throw new RetryAt(parked, `${domain} can't be reached, so it is left alone for now`);
    }

    /** Records the failure, and parks every delivery to the instance if it is now parked. */
    const unreachable = async () => {
        const until = await recordUnreachable(ctx, domain);
        if (until) await postponeGroup(ctx, deliverQueue, domain, until);
    };

    const url = versiaUrl(domain, "/inbox");
    let reply: FederationReply;
    try {
        reply = await sendSigned(ctx, "POST", url, new TextEncoder().encode(body));
    } catch (error) {
        if (error instanceof Unreachable) await unreachable();
        throw error;
    }
    const { status } = reply;

    // Any response other than a server failure shows the instance is up, so its deliveries can go.
    if (status >= 500 || status === 408) await unreachable();
    else if (await recordReached(ctx, domain)) await resumeGroup(ctx, deliverQueue, domain);

    const quotaBack = rateLimitReset(reply.headers, now);
    if (quotaBack && quotaBack > now) await postponeGroup(ctx, deliverQueue, domain, quotaBack);

    if (status >= 200 && status <= 299) return;

    if (status === 429 || status === 503) {
        const runAt = retryAfter(reply.headers, now);
        if (runAt && runAt >= giveUpAt) {
            throw new PermanentFailure(`${domain} asked to wait past ${tried}`);
        }
        if (runAt && runAt > now) {
            await postponeGroup(ctx, deliverQueue, domain, runAt);
            throw new RetryAt(runAt, `${domain} asked to wait (${status})`);
        }
    }

    if (status >= 400 && status <= 499 && status !== 408 && status !== 429) {
        throw new PermanentFailure(`${domain} refused the delivery (${status})`);
    }
    throw new Error(`${domain} answered ${status}`);
};
