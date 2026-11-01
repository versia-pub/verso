/**
 * Posting scheduled statuses when they are due, from a task that runs every minute.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { HttpError } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { insertDraft, prepareDraft } from "../notes/notes.ts";
import { deleteScheduled, dueScheduled, type ScheduledNoteRow } from "./schedule_queries.ts";
import { draftOf } from "./schedules.ts";

const logger = getLogger(["verso", "schedules"]);

/** The queue of the task that posts the scheduled statuses that are due. */
export const scheduledNotesQueue = "scheduled-statuses";

/** How many scheduled statuses are read at once. */
const batch = 100;

/**
 * Posts `row`, once: the scheduled status is removed in the transaction that posts it. One that
 * can't be posted any more, such as a reply to a status since deleted, is dropped, as on Mastodon.
 */
const publish = async (ctx: Context, row: ScheduledNoteRow) => {
    try {
        const prepared = await prepareDraft(ctx, draftOf(row.params));
        const posted = await ctx.transaction(async (tx) => {
            // Posted already.
            if (!await deleteScheduled(tx, row.id)) return true;
            return await insertDraft(tx, row.account_id, prepared) !== undefined;
        });
        if (posted) return;

        logger.info("Dropped the scheduled status {id}, as its reply can't be posted", row);
    } catch (error) {
        if (!(error instanceof HttpError)) throw error;

        await deleteScheduled(ctx, row.id);
        logger.info("Dropped the scheduled status {id}, which can't be posted: {error}", {
            id: row.id,
            error: error.description ?? error.message,
        });
    }
};

/** Posts the scheduled statuses that are due by now, the first due first. */
export const publishDue = async (ctx: Context): Promise<void> => {
    for (;;) {
        const due = await dueScheduled(ctx, batch);
        for (const row of due) await publish(ctx, row);
        if (due.length < batch) return;
    }
};
