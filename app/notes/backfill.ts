/**
 * Backfilling remote threads: fetching the replies Verso hasn't heard of, from the replies
 * collections of a remote status and of the replies under it, when a local user opens it, as
 * Mastodon does.
 * @see https://versia.pub/api/endpoints#entity-collections
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { parseReference, v0_6 } from "@versia/protocol";
import { z } from "zod";
import { fetchBudget, isRemoteFailure, withDeadline } from "../federation/resolver.ts";
import { domainsOf } from "../instances/instance_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { fetchNoteCollection } from "./totals.ts";

const logger = getLogger(["verso", "notes"]);

/** The queue that fetches the replies of remote statuses. */
export const backfillQueue = "reply-backfill";

const BackfillJob = z.object({ noteId: z.string() });

/** How old a status must be before its replies are fetched, so that it has some. */
const initialWaitMs = 5 * 60_000;

/** How long after its replies were fetched they may be fetched again. */
const cooldownMs = 15 * 60_000;

/**
 * How long one backfill fetches for, within the 5 minutes a job may take before another worker
 * claims it.
 */
const walkMs = 4 * 60_000;

/**
 * How long a stored reply is used as it is, rather than fetched again. Longer than usual, as a
 * thread's replies are many, and their edits are sent anyway.
 */
const storedMs = 7 * 24 * 60 * 60_000;

/** How many replies, and pages of replies, one backfill fetches at most, as on Mastodon. */
export type BackfillLimits = { readonly replies: number; readonly pages: number };

const limits: BackfillLimits = { replies: 1000, pages: 500 };

/** Whether the replies of the status `noteId` were fetched in the last 15 minutes. */
const fetchedRecently = async (ctx: Context, noteId: string) => {
    const row = await ctx.db.selectFrom("reply_backfills").select("fetched_at")
        .where("note_id", "=", noteId)
        .executeTakeFirst();

    return row !== undefined && ctx.clock.now().getTime() - row.fetched_at.getTime() < cooldownMs;
};

const markFetched = async (ctx: Context, noteId: string) => {
    const fetched_at = ctx.clock.now();
    await ctx.db.insertInto("reply_backfills")
        .values({ note_id: noteId, fetched_at })
        .onConflict((conflict) => conflict.column("note_id").doUpdateSet({ fetched_at }))
        .execute();
};

/**
 * Queues a job to fetch the replies of `note`, when a local user opens it, if it is a public or
 * unlisted remote status at least 5 minutes old, and they weren't fetched in the last 15 minutes.
 * Returns whether it queued one.
 */
export const backfillLater = async (ctx: Context, note: NoteRow): Promise<boolean> => {
    if (note.instance_id === null) return false;
    if (note.visibility !== "public" && note.visibility !== "unlisted") return false;
    if (ctx.clock.now().getTime() - note.created_at.getTime() < initialWaitMs) return false;
    if (await fetchedRecently(ctx, note.id)) return false;

    const payload: z.infer<typeof BackfillJob> = { noteId: note.id };
    await enqueue(ctx, {
        queue: backfillQueue,
        payload,
        group: note.instance_id,
        maxAttempts: 3,
        dedupeKey: `replies:${note.id}`,
    });
    return true;
};

/**
 * Fetches the replies of the remote status `root`, and of the replies under it, depth first, up to
 * `max` of each, for at most 4 minutes. A reply whose replies were fetched in the last 15 minutes
 * is skipped, as is one on a blocked instance. Failing to fetch `root`'s replies is thrown, so the
 * job is retried; failing for a reply under it only skips that reply.
 */
export const fetchReplies = async (
    ctx: Context,
    root: NoteRow,
    max: BackfillLimits = limits,
): Promise<void> => {
    const until = ctx.clock.now().getTime() + walkMs;
    const timed = withDeadline(ctx, fetchBudget(0, until));
    const stack = [root];
    let replies = 0;
    let pages = 0;

    const walk = async (domain: string, remoteId: string) => {
        for (let offset = 0;;) {
            if (pages >= max.pages || ctx.clock.now().getTime() >= until) return;
            pages++;

            const page = await fetchNoteCollection(timed, domain, remoteId, "replies", {
                offset,
                limit: 40,
            });
            if (page === null) return;
            const parsed = v0_6.URICollection.safeParse(page);
            if (!parsed.success) throw new PermanentFailure(`${domain} sent invalid replies`);

            for (const item of parsed.data.items) {
                if (replies >= max.replies) return;

                const reference = parseReference(item, domain);
                if (reference === undefined) continue;
                const id = await ctx.federation.resolve(
                    timed,
                    reference,
                    "Note",
                    { ...fetchBudget(20, until), backfill: true },
                    storedMs,
                ).catch((error) => {
                    if (isRemoteFailure(error)) return undefined;
                    throw error;
                });
                if (id === undefined) continue;

                replies++;
                const reply = await findNote(ctx, id);
                if (reply !== undefined) stack.push(reply);
            }

            offset += parsed.data.items.length;
            if (parsed.data.items.length === 0 || offset >= parsed.data.total) return;
        }
    };

    for (let note = stack.pop(); note !== undefined; note = stack.pop()) {
        if (replies >= max.replies) return;
        if (note !== root && await fetchedRecently(ctx, note.id)) continue;
        if (note.instance_id === null || note.remote_id === null) continue;

        const [domain] = await domainsOf(ctx, [note.instance_id], "versia");
        if (domain === undefined || await ctx.federation.isBlocked(ctx, domain)) continue;

        await markFetched(ctx, note.id);
        try {
            await walk(domain, note.remote_id);
        } catch (error) {
            if (note === root) throw error;
            logger.info("Couldn't fetch the replies of {id} from {domain}: {error}", {
                id: note.remote_id,
                domain,
                error,
            });
        }
    }
};

/** Fetches the replies of the status in the job, unless it has been deleted since. */
export const backfillHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = BackfillJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a reply backfill job");

    const note = await findNote(ctx, payload.data.noteId);
    if (note !== undefined) await fetchReplies(ctx, note);
};
