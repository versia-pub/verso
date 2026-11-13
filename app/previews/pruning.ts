import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import {
    type CardPruneCursor,
    clearCardImages,
    deleteUnusedCards,
    oldCardsQuery,
} from "./pruning_queries.ts";

/** Prunes old preview cards and their images, a batch at a time. */
export const cardPruneQueue = "preview-cards-prune";

/** Starts {@link cardPruneQueue}'s work each day, if `preview_card_days` is set. */
export const cardPruneStartQueue = "preview-cards-prune-start";

/** How many cards one job looks at. */
const cardsPerJob = 500;

/** What pruning did: how many cards it deleted, and how many others lost their image. */
export type CardsPruned = { deleted: number; cleared: number };

const PruneJob = z.object({
    before: z.iso.datetime().transform((value) => new Date(value)),
    after: z.object({ fetchedAt: z.iso.datetime(), id: z.string() }).nullable(),
});

const enqueueBatch = (ctx: Context, before: Date, after: CardPruneCursor | null) =>
    enqueue(ctx, {
        queue: cardPruneQueue,
        payload: {
            before: before.toISOString(),
            after: after && { fetchedAt: after.fetchedAt.toISOString(), id: after.id },
        },
        dedupeKey: `${cardPruneQueue}:${before.toISOString()}:${after?.id ?? ""}`,
    });

/** Queues a pass over the cards fetched more than `preview_card_days` ago, if that is set. */
export const startCardPruning = async (ctx: Context): Promise<void> => {
    if (ctx.settings.previewCardMs === null) return;

    await enqueueBatch(ctx, new Date(ctx.clock.now().getTime() - ctx.settings.previewCardMs), null);
};

/** Prunes the next batch of a pass, and queues the job for the batch after, if there is one. */
export const cardPruneHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = PruneJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a card prune job");

    const { before, after } = payload.data;

    await ctx.transaction(async (tx) => {
        const cursor = after && { fetchedAt: new Date(after.fetchedAt), id: after.id };
        const { last } = await pruneBatch(tx, before, cursor ?? undefined);
        if (last !== undefined) await enqueueBatch(tx, before, last);
    });
};

/**
 * Prunes the cards whose page was fetched before `before`, a batch to a transaction: deletes those
 * that nothing uses, and takes the images off the rest. Returns how many of each.
 */
export const pruneCards = async (ctx: Context, before: Date): Promise<CardsPruned> => {
    let after: CardPruneCursor | undefined;
    const total: CardsPruned = { deleted: 0, cleared: 0 };

    while (true) {
        const { last, deleted, cleared } = await ctx.transaction((tx) =>
            pruneBatch(tx, before, after)
        );

        total.deleted += deleted;
        total.cleared += cleared;
        if (last === undefined) return total;

        after = last;
    }
};

/**
 * Prunes the next batch after `after`. Returns the last card looked at, unless there were none, and
 * what it pruned.
 */
const pruneBatch = async (
    ctx: Context,
    before: Date,
    after: CardPruneCursor | undefined,
): Promise<CardsPruned & { last: CardPruneCursor | undefined }> => {
    const batch = await oldCardsQuery(ctx, before, after, cardsPerJob).execute();
    const lastRow = batch.at(-1);
    if (lastRow === undefined) return { last: undefined, deleted: 0, cleared: 0 };

    const ids = batch.map((row) => row.id);
    const deleted = await deleteUnusedCards(ctx, ids, before);
    const cleared = await clearCardImages(ctx, ids, before);

    return { last: { fetchedAt: lastRow.fetched_at, id: lastRow.id }, deleted, cleared };
};
