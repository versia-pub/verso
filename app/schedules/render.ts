import type { ScheduledStatus } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { reservationsOf } from "../media/attachment_queries.ts";
import { renderAttachment } from "../media/render.ts";
import type { ScheduledNoteRow } from "./schedule_queries.ts";

/**
 * Scheduled statuses as Mastodon gives them, with the `params` it would post them with and the
 * media reserved for them, but not the app they were scheduled from.
 */
export const renderScheduled = async (
    ctx: Context,
    rows: readonly ScheduledNoteRow[],
): Promise<ScheduledStatus[]> => {
    const reserved = await reservationsOf(ctx, rows.map((row) => row.id));

    return rows.map((row) => ({
        id: row.id,
        scheduled_at: row.scheduled_at.toISOString(),
        params: {
            ...row.params,
            // As Mastodon has them once a status is scheduled.
            scheduled_at: null,
            idempotency: null,
            with_rate_limit: false,
        },
        media_attachments: (reserved.get(row.id) ?? []).map((media) =>
            renderAttachment(ctx, media)
        ),
    }));
};
