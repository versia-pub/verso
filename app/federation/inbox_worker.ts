/**
 * The inbox worker, which applies what other instances sent, once the inbox has queued it.
 * @module
 */
import { HttpError } from "../http/errors.ts";
import { findInstanceId } from "../instances/instances.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import { checkEntity, InboxJob } from "./inbox.ts";
import type { Registry } from "./registry.ts";

/**
 * Runs inbox jobs: checks each entity again, in case Verso changed since it was queued, checks
 * that the instance that sent it may, and applies it. An entity that is invalid or sent by the
 * wrong instance is given up on; anything else that fails, such as the database, is retried.
 */
export const inboxHandler = (registry: Registry): Handler => async (ctx, job) => {
    const payload = InboxJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't an inbox job");
    const { signer, body } = payload.data;

    let checked;
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

    await ctx.transaction((tx) => type.receive(tx, entity, { domain: signer, instanceId }));
};
