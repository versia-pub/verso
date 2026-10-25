/**
 * The inbox worker, which applies what other instances sent, once the inbox has queued it.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { HttpError } from "../http/errors.ts";
import { findInstanceId } from "../instances/instances.ts";
import type { DeadPayload } from "../jobs/queue.ts";
import type { JobPayload } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { checkEntity, InboxJob } from "./inbox.ts";
import { queueMessage } from "./messaging.ts";
import type { Registry } from "./registry.ts";
import { fetchBudget } from "./resolver.ts";

const logger = getLogger(["verso", "federation"]);

/**
 * How long a job may spend fetching what an entity refers to. The fetch under way when it runs out
 * may take a minute more, its entity and the metadata to check its signature, so the job still
 * ends well within its five-minute lease.
 */
const prepareMs = 2 * 60_000;

const Named = z.object({ type: z.string(), id: z.string().optional() });

/** What an entity is, for a message about it: its type, and its id if it has one. */
const describe = (body: string) => {
    let parsed: ReturnType<typeof Named.safeParse>;
    try {
        parsed = Named.safeParse(JSON.parse(body));
    } catch {
        return "entity";
    }
    if (!parsed.success) return "entity";

    return parsed.data.id === undefined
        ? parsed.data.type
        : `${parsed.data.type} ${parsed.data.id}`;
};

/**
 * What an inbox job keeps once it dies: who sent what, without the entity, which can be large, so
 * an instance can't fill the database with what Verso refuses.
 */
export const inboxDeadPayload: DeadPayload = (payload: JobPayload): JobPayload => {
    const job = InboxJob.safeParse(payload);
    return job.success ? { signer: job.data.signer, entity: describe(job.data.body) } : {};
};

/**
 * Runs inbox jobs: checks each entity again, in case Verso changed since it was queued, checks
 * that the instance that sent it may, and applies it. One from an instance blocked since is
 * dropped. An entity that is invalid or sent by the wrong instance is given up on, and its sender
 * is told why, if it takes instance messages; anything else that fails, such as the database, is
 * retried.
 */
export const inboxHandler = (registry: Registry): Handler => async (ctx, job) => {
    const payload = InboxJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't an inbox job");
    const { signer, body } = payload.data;

    if (await ctx.federation.isBlocked(ctx, signer)) {
        logger.info("Dropping what {signer} sent, since it is now blocked", { signer });
        return;
    }

    try {
        await apply(ctx, registry, signer, body);
    } catch (error) {
        if (!(error instanceof PermanentFailure)) throw error;

        const text = `${ctx.urls.domain} gave up on the ${
            describe(body)
        } you sent its inbox: ${error.message}`;
        await queueMessage(ctx, signer, text);
        throw error;
    }
};

/** Checks the entity `signer` sent, and applies it. */
const apply = async (ctx: Context, registry: Registry, signer: string, body: string) => {
    let checked: ReturnType<typeof checkEntity>;
    try {
        checked = checkEntity(registry, new TextEncoder().encode(body));
    } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        throw new PermanentFailure(`The entity isn't valid any more: ${error.message}`);
    }
    if (!checked) return;

    const { type, entity } = checked;
    const authority = type.authority(entity, signer);
    if (authority !== signer) {
        throw new PermanentFailure(
            `${signer} may not send this ${type.type}, which only ${authority ?? "nobody"} may`,
        );
    }

    // Its row was made when its key was fetched, to check the signature.
    const instanceId = await findInstanceId(ctx, signer);
    if (instanceId === undefined) throw new Error(`${signer} isn't a known instance`);

    const sender = { domain: signer, instanceId, fetched: false };
    await type.prepare?.(
        ctx,
        entity,
        sender,
        fetchBudget(20, ctx.clock.now().getTime() + prepareMs),
    );
    await ctx.transaction((tx) => type.receive(tx, entity, sender));
};
