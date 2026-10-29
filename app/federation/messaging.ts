/**
 * Instance messaging: instances tell each other, in plain text, why something the other sent
 * failed, as Versia specifies for debugging federation. Messages Verso receives are only logged,
 * for admins to read, and it sends messages to instances that accept them when it gives up on
 * something they sent.
 * @see https://versia.pub/extensions/instance-messaging
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { defineRoute, type Route } from "../http/route.ts";
import { NoBody } from "../http/responses.ts";
import { takesMessages } from "../instances/instance_queries.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { versiaUrl } from "../kernel/urls.ts";
import { postUnsigned } from "./request.ts";

export const messagingExtension = "pub.versia:instance_messaging";

/**
 * The longest message that is logged, enough to name what failed and why, and to quote some of it.
 * Longer messages are truncated, so a message can't fill the logs.
 */
const maxMessageLength = 4096;

const logger = getLogger(["verso", "federation", "messaging"]);

/**
 * Where remote instances send messages. Versia doesn't sign them, so anyone may send one, and what
 * it says about who sent it can't be trusted. Rate limits keep anyone from sending too many.
 */
export const messagingRoute: Route = defineRoute({
    method: "POST",
    path: "/.versia/v0.6/messaging",
    summary: "A message from another instance about why something this one sent failed",
    tags: ["versia"],
    textBody: true,
    body: z.string().trim().min(1),
    responses: { 200: NoBody },
    handler: (_ctx, { body }) => {
        const cut = body.length > maxMessageLength;
        logger.info("Another instance sent a message: {message}", {
            message: cut ? `${body.slice(0, maxMessageLength)}…` : body,
        });

        return Promise.resolve({ status: 200 });
    },
});

export const messageQueue = "versia-messages";

/** The payload of a message job: what to tell an instance. */
export const MessageJob = z.object({
    domain: z.string(),
    text: z.string(),
});
export type MessageJob = z.output<typeof MessageJob>;

/**
 * How long a message counts as already sent to an instance, so an instance that sends the same
 * thing repeatedly is told only once.
 */
const dedupeMs = 60 * 60_000;

/** Messages help, but aren't worth many retries. */
const maxAttempts = 3;

/** Queues `text` for the instance at `domain`, if it accepts messages. */
export const queueMessage = async (ctx: Context, domain: string, text: string): Promise<void> => {
    if (!await takesMessages(ctx, domain)) return;

    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    const payload: MessageJob = { domain, text };
    await enqueue(ctx, {
        queue: messageQueue,
        payload,
        maxAttempts,
        dedupeKey: `message:${domain}:${digest.toHex()}`,
        group: domain,
        keepUntil: new Date(ctx.clock.now().getTime() + dedupeMs),
    });
};

/**
 * Runs message jobs: posts each message to its instance, unsigned, as Versia specifies. One to an
 * instance blocked since is dropped. If the instance rejects it with a 4xx, it is given up on; any
 * other failure is retried a few times.
 */
export const messageHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = MessageJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a message job");
    const { domain, text } = payload.data;

    if (await ctx.federation.isBlocked(ctx, domain)) return;

    const { status } = await postUnsigned(ctx, versiaUrl(domain, "/messaging"), text);
    if (status >= 200 && status <= 299) return;

    if (status >= 400 && status <= 499 && status !== 408 && status !== 429) {
        throw new PermanentFailure(`${domain} refused the message (${status})`);
    }
    throw new Error(`${domain} answered ${status}`);
};
