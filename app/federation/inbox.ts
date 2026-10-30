/**
 * The shared inbox, where remote instances send entities. It checks only what must be answered
 * immediately, and queues the rest for the inbox worker.
 * @see https://versia.pub/federation/http
 * @module
 */
import { parseJson } from "@versia/protocol";
import { z } from "zod";
import { BadRequest, ValidationFailed } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { NoBody } from "../http/responses.ts";
import { recordReached } from "../instances/reachability.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { resumeGroup } from "../jobs/job_pause_queries.ts";
import type { Context } from "../kernel/context.ts";
import { deliverQueue } from "./deliver.ts";
import type { EntityType, Registry } from "./registry.ts";

export const inboxQueue = "inbox";

/**
 * How long an entity counts as already received: as long as a signature is accepted, from five
 * minutes before its timestamp to five after, so a replayed request is always caught. A resendable
 * entity counts as received only when it comes with the same signature.
 */
const dedupeMs = 10 * 60_000;

/** The payload of an inbox job: an entity as it arrived, for the inbox worker. */
export const InboxJob = z.object({
    /** The domain of the instance that sent it. */
    signer: z.string(),
    /** The body exactly as signed, already validated against its type's schema. */
    body: z.string(),
});
export type InboxJob = z.output<typeof InboxJob>;

const Typed = z.object({ type: z.string() });

/** Extension types are namespaced, such as `pub.versia:likes/Like`; core ones aren't. */
const isExtensionType = (type: string) => type.includes(":");

/** A schema's problems by field path, as the client API reports them. */
const detailsOf = (error: z.ZodError) => {
    const details: Record<string, string[]> = {};
    for (const issue of error.issues) {
        (details[["body", ...issue.path.map(String)].join(".")] ??= []).push(issue.message);
    }

    return details;
};

/** An entity and its type, once validated. */
export type Checked = { readonly type: EntityType; readonly entity: unknown };

/**
 * Validates an entity's body: it must be Versia JSON, of a type in `registry`, matching its schema.
 * It throws when it isn't, and returns `undefined` for an extension type Verso doesn't know, which
 * is dropped, as the spec says.
 * @see https://versia.pub/extensions
 */
export const checkEntity = (registry: Registry, body: Uint8Array): Checked | undefined => {
    const parsed = parseJson(body);
    if (!parsed.ok) throw new BadRequest(`The body isn't valid Versia JSON: ${parsed.reason}`);

    const typed = Typed.safeParse(parsed.value);
    if (!typed.success) throw new ValidationFailed(detailsOf(typed.error));

    const type = registry.types.get(typed.data.type);
    if (!type) {
        if (isExtensionType(typed.data.type)) return undefined;
        throw new ValidationFailed({ "body.type": [`Unknown type ${typed.data.type}`] });
    }

    const checked = type.schema.safeParse(parsed.value);
    if (!checked.success) throw new ValidationFailed(detailsOf(checked.error));

    return { type, entity: checked.data };
};

/**
 * Validates an entity sent by a remote instance, signed with `signature`, and queues it for the
 * inbox worker, unless it was already received or is dropped. An instance that sends one is
 * reachable again.
 */
export const queueEntity = async (
    ctx: Context,
    registry: Registry,
    signer: string,
    body: Uint8Array<ArrayBuffer>,
    signature: string,
): Promise<void> => {
    const checked = checkEntity(registry, body);
    if (!checked) return;

    // It is up, so what is queued for it can go, and what is created from now on.
    if (await recordReached(ctx, signer)) await resumeGroup(ctx, deliverQueue, signer);

    const now = ctx.clock.now();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    const job: InboxJob = {
        signer,
        body: new TextDecoder().decode(body),
    };

    await enqueue(ctx, {
        queue: inboxQueue,
        payload: job,
        dedupeKey: `inbox:${signer}:${digest.toHex()}` +
            (checked.type.resendable ? `:${signature}` : ""),
        keepUntil: new Date(now.getTime() + dedupeMs),
        // Entities arrive in the hundreds at busy times, so workers find them by polling.
        wake: false,
    });
};

/** The shared inbox route, accepting the types in `registry`. */
export const inboxRoute = (registry: Registry): Route =>
    defineRoute({
        method: "POST",
        path: "/.versia/v0.6/inbox",
        summary: "Receive entities",
        tags: ["versia"],
        signed: true,
        responses: { 202: NoBody },
        handler: async (ctx, { signedBy, signedBody, signature }) => {
            await queueEntity(ctx, registry, signedBy, signedBody, signature);
            return { status: 202 };
        },
    });
