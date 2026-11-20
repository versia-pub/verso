/**
 * Fetching the metadata of the instances Verso has keys for at least every 24 hours, so a key an
 * instance replaced stops being accepted even if no signature fails to verify.
 * @module
 */
import { z } from "zod";
import { enqueueAll } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { staleKeyDomains } from "./instance_queries.ts";
import { refetchMetadata } from "./remote_keys.ts";

/** Fetches the metadata of one instance. */
export const metadataRefreshQueue = "instance-metadata-refresh";

/** Starts {@link metadataRefreshQueue}'s work each hour. */
export const metadataRefreshStartQueue = "instance-metadata-refresh-start";

/**
 * How old a stored key may get before the instance's metadata is fetched again. Versia says a
 * verifier should do so at least this often.
 * @see https://dev.versia.pub/signatures.md#key-rotation
 */
const maxKeyAgeMs = 24 * 3_600_000;

const RefreshJob = z.object({ domain: z.string() });

/** Queues a fetch for each instance whose key was last fetched more than 24 hours ago. */
export const startMetadataRefresh = async (ctx: Context): Promise<void> => {
    const domains = await staleKeyDomains(ctx, new Date(ctx.clock.now().getTime() - maxKeyAgeMs));

    await enqueueAll(
        ctx,
        domains.map((domain) => ({
            queue: metadataRefreshQueue,
            payload: { domain },
            group: domain,
            dedupeKey: `${metadataRefreshQueue}:${domain}`,
            maxAttempts: 1,
        })),
    );
};

/**
 * Fetches an instance's metadata again, unless the instance is blocked. A failed fetch isn't
 * retried here, since the next sweep finds the instance still stale.
 */
export const metadataRefreshHandler: Handler = async (
    ctx: Context,
    job: JobsTable,
): Promise<void> => {
    const payload = RefreshJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a metadata refresh job");

    const { domain } = payload.data;
    if (await ctx.federation.isBlocked(ctx, domain)) return;

    await refetchMetadata(ctx, domain);
};
