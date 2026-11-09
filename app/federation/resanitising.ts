import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml, sanitizerVersion } from "../kernel/html.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";

/** Sanitises stored remote HTML that an older sanitiser, or none, went through. */
export const resanitiseQueue = "html-resanitise";

/** Starts {@link resanitiseQueue}'s work, once for each version of the sanitiser. */
export const resanitiseStartQueue = "html-resanitise-start";

/** How many rows one job sanitises. */
const rowsPerJob = 500;

const tables = ["accounts", "notes", "note_versions"] as const;

/** The table a job sanitises rows of, and the id after which they start. */
const ResanitiseJob = z.object({ table: z.enum(tables), after: z.string() });

const enqueueBatch = (ctx: Context, payload: z.infer<typeof ResanitiseJob>) =>
    enqueue(ctx, {
        queue: resanitiseQueue,
        payload,
        dedupeKey: `${resanitiseQueue}:${sanitizerVersion}:${payload.table}:${payload.after}`,
    });

/**
 * Queues the first job, unless one was queued for this version before: its dedupe key is kept for
 * good, so each version's work starts only once.
 */
export const startResanitising = async (ctx: Context): Promise<void> => {
    await enqueue(ctx, {
        queue: resanitiseQueue,
        payload: { table: tables[0], after: "" },
        dedupeKey: `${resanitiseQueue}:${sanitizerVersion}`,
        keepUntil: new Date("9999-12-31T00:00:00Z"),
    });
};

/**
 * Sanitises the next rows with stale HTML in one table, and queues the job for the rows after, or
 * for the next table. Only rows still as read are written, since a status or profile fetched
 * meanwhile has its HTML sanitised by this version already. What is shown doesn't change, so
 * nothing is told.
 */
export const resanitiseHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = ResanitiseJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a resanitise job");

    const { table, after } = payload.data;
    await ctx.transaction(async (tx) => {
        const last = await resanitise[table](tx, after);
        const next = tables[tables.indexOf(table) + 1];

        if (last !== undefined) await enqueueBatch(tx, { table, after: last });
        else if (next !== undefined) await enqueueBatch(tx, { table: next, after: "" });
    });
};

/** Sanitises the next rows of each table after an id, and returns the last one's, if any. */
const resanitise: Record<
    typeof tables[number],
    (ctx: Context, after: string) => Promise<string | undefined>
> = {
    accounts: async (ctx, after) => {
        const rows = await ctx.db.selectFrom("accounts")
            .select(["id", "note_html", "fields", "html_version"])
            .where("instance_id", "is not", null)
            .where("html_version", "!=", sanitizerVersion)
            .where("id", ">", after)
            .orderBy("id")
            .limit(rowsPerJob)
            .execute();

        for (const row of rows) {
            await ctx.db.updateTable("accounts")
                .set({
                    note_html: sanitizeHtml(row.note_html),
                    fields: row.fields.map((field) => ({
                        ...field,
                        name_html: sanitizeHtml(field.name_html),
                        value_html: sanitizeHtml(field.value_html),
                    })),
                    html_version: sanitizerVersion,
                })
                .where("id", "=", row.id)
                .where("html_version", "=", row.html_version)
                .execute();
        }

        return rows.at(-1)?.id;
    },

    notes: async (ctx, after) => {
        const rows = await ctx.db.selectFrom("notes")
            .select(["id", "content_html", "html_version"])
            .where("instance_id", "is not", null)
            .where("html_version", "!=", sanitizerVersion)
            .where("id", ">", after)
            .orderBy("id")
            .limit(rowsPerJob)
            .execute();

        for (const row of rows) {
            await ctx.db.updateTable("notes")
                .set({
                    content_html: sanitizeHtml(row.content_html),
                    html_version: sanitizerVersion,
                })
                .where("id", "=", row.id)
                .where("html_version", "=", row.html_version)
                .execute();
        }

        return rows.at(-1)?.id;
    },

    note_versions: async (ctx, after) => {
        const rows = await ctx.db.selectFrom("note_versions")
            .innerJoin("notes", "notes.id", "note_versions.note_id")
            .select([
                "note_versions.id",
                "note_versions.content_html",
                "note_versions.html_version",
            ])
            .where("notes.instance_id", "is not", null)
            .where("note_versions.html_version", "!=", sanitizerVersion)
            .where("note_versions.id", ">", after)
            .orderBy("note_versions.id")
            .limit(rowsPerJob)
            .execute();

        for (const row of rows) {
            await ctx.db.updateTable("note_versions")
                .set({
                    content_html: sanitizeHtml(row.content_html),
                    html_version: sanitizerVersion,
                })
                .where("id", "=", row.id)
                .where("html_version", "=", row.html_version)
                .execute();
        }

        return rows.at(-1)?.id;
    },
};
