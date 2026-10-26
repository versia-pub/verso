/**
 * Totals of remote statuses: how many likes, boosts and replies their instances report. Verso can't
 * count these itself, as it only hears of some of them. A job fetches them from the status's
 * collections, so saving a status doesn't wait on its instance.
 * @see https://versia.pub/api/endpoints#entity-collections
 * @module
 */
import { z } from "zod";
import { fetchSigned } from "../federation/request.ts";
import { domainsOf } from "../instances/instance_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { enqueue } from "../jobs/job_queries.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { saveTotals, totalsOf } from "./total_queries.ts";

/** The queue that fetches the totals of remote statuses. */
export const totalsQueue = "note-totals";

const TotalsJob = z.object({ noteId: z.string() });

/** Queues a job to fetch the totals of `note`, a remote status, unless one is already queued. */
export const fetchTotalsLater = async (ctx: Context, note: NoteRow): Promise<void> => {
    if (note.instance_id === null) return;

    const payload: z.infer<typeof TotalsJob> = { noteId: note.id };
    await enqueue(ctx, {
        queue: totalsQueue,
        payload,
        group: note.instance_id,
        maxAttempts: 3,
        dedupeKey: `totals:${note.id}`,
    });
};

/** How long totals are shown before a local user opening their status triggers a fresh fetch. */
const totalsMaxAgeMs = 60 * 60_000;

/**
 * Queues a refetch of the totals of the status `noteId`, or of the status it boosts, if it is a
 * remote status and the totals were fetched over an hour ago, or never, when a local user opens it.
 */
export const refreshTotals = async (ctx: Context, noteId: string): Promise<void> => {
    const opened = await findNote(ctx, noteId);
    if (opened === undefined) return;

    const note = opened.reblog_of_id === null ? opened : await findNote(ctx, opened.reblog_of_id);
    if (note === undefined || note.instance_id === null) return;

    const fetchedAt = (await totalsOf(ctx, [note.id])).get(note.id)?.fetched_at;
    if (fetchedAt && ctx.clock.now().getTime() - fetchedAt.getTime() < totalsMaxAgeMs) return;

    await fetchTotalsLater(ctx, note);
};

/**
 * The largest total stored, which a database integer can hold. An instance can report more, but no
 * status has more.
 */
const largestTotal = 2 ** 31 - 1;

/** Any collection's total, which is all of it that Verso reads. */
const Total = z.object({ total: z.number().int().min(0) });

/**
 * The total of one of a status's collections, or `null` if its instance doesn't have it. Requests
 * one item, as a page can't be empty.
 */
const fetchTotal = async (ctx: Context, domain: string, remoteId: string, name: string) => {
    const url = entityUrl(domain, "Note", remoteId);
    url.pathname += `/collections/${encodeURIComponent(name)}`;
    url.searchParams.set("limit", "1");

    const reply = await fetchSigned(ctx, url);
    if (reply.status === 404 || reply.status === 410) return null;
    if (reply.status < 200 || reply.status > 299) {
        throw new Error(`${domain} answered ${reply.status} for ${name} of ${remoteId}`);
    }

    let parsed: ReturnType<typeof Total.safeParse> | undefined;
    try {
        parsed = Total.safeParse(JSON.parse(new TextDecoder().decode(reply.body)));
    } catch {
        parsed = undefined;
    }
    if (!parsed?.success) throw new PermanentFailure(`${domain} sent an invalid ${name}`);

    return Math.min(parsed.data.total, largestTotal);
};

/**
 * Fetches the totals of the status in the job from its instance. A status deleted since, or a
 * boost, has none, and nor does one on a blocked instance.
 */
export const totalsHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = TotalsJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a note totals job");

    const note = await findNote(ctx, payload.data.noteId);
    if (note === undefined || note.instance_id === null || note.remote_id === null) return;
    if (note.reblog_of_id !== null) return;
    const [domain] = await domainsOf(ctx, [note.instance_id], "versia");
    if (domain === undefined || await ctx.federation.isBlocked(ctx, domain)) return;

    await saveTotals(ctx, {
        note_id: note.id,
        likes: await fetchTotal(ctx, domain, note.remote_id, "pub.versia:likes/Likes"),
        shares: await fetchTotal(ctx, domain, note.remote_id, "pub.versia:share/Shares"),
        replies: await fetchTotal(ctx, domain, note.remote_id, "replies"),
        fetched_at: ctx.clock.now(),
    });
};
