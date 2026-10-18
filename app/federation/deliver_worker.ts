/**
 * The delivery worker, which sends queued entities to other instances' inboxes.
 * @see https://versia.pub/federation/http
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { postponeGroup } from "../jobs/queue.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure, RetryAt } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { DeliverJob, deliverQueue } from "./deliver.ts";
import { sendSigned } from "./request.ts";

const logger = getLogger(["verso", "federation"]);

/** How long a delivery is tried for, counted from when it was queued. */
export const deliveryMaxAgeMs = 48 * 60 * 60_000;

/** When `Retry-After` says to try again, in seconds or as a date, if it says. */
export const retryAfter = (headers: Headers, now: Date): Date | undefined => {
    const value = headers.get("retry-after");
    if (!value) return undefined;

    if (/^\d+$/.test(value)) return new Date(now.getTime() + Number(value) * 1000);

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * When an instance's rate limit lets requests through again, if it says none are left, with
 * `RateLimit-Remaining` and `RateLimit-Reset` in seconds, as Verso sends them.
 */
export const rateLimitReset = (headers: Headers, now: Date): Date | undefined => {
    const reset = headers.get("ratelimit-reset");
    if (headers.get("ratelimit-remaining") !== "0" || !reset || !/^\d+$/.test(reset)) {
        return undefined;
    }

    return new Date(now.getTime() + Number(reset) * 1000);
};

/**
 * Runs delivery jobs: signs each entity and posts it to its instance's inbox. An instance that
 * refuses it, with a 4xx other than 408 and 429, is given up on; any other failure is retried, when
 * the instance asks if it does, for up to 48 hours. One to an instance blocked since is dropped.
 * An instance that asks to wait, or has no requests left, isn't sent any delivery until then.
 */
export const deliverHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = DeliverJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a delivery job");
    const { domain, body } = payload.data;

    if (await ctx.federation.isBlocked(ctx, domain)) {
        logger.info("Dropping a delivery to {domain}, since it is now blocked", { domain });
        return;
    }

    const now = ctx.clock.now();
    const giveUpAt = new Date(job.created_at.getTime() + deliveryMaxAgeMs);
    if (now >= giveUpAt) throw new PermanentFailure(`${domain} couldn't be reached in 48 hours`);

    const url = new URL(`https://${domain}/.versia/v0.6/inbox`);
    const reply = await sendSigned(ctx, "POST", url, new TextEncoder().encode(body));
    const { status } = reply;

    const quotaBack = rateLimitReset(reply.headers, now);
    if (quotaBack && quotaBack > now) await postponeGroup(ctx, deliverQueue, domain, quotaBack);

    if (status >= 200 && status <= 299) return;

    if (status === 429 || status === 503) {
        const runAt = retryAfter(reply.headers, now);
        if (runAt && runAt >= giveUpAt) {
            throw new PermanentFailure(`${domain} asked to wait past 48 hours`);
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
