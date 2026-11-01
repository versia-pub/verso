import type { ScheduledStatus } from "@versia/client-api";
import type { ScheduledNoteRow } from "./schedule_queries.ts";

/**
 * Scheduled statuses as Mastodon gives them, with the `params` it would post them with, but not
 * the app they were scheduled from. Media can't be scheduled yet.
 */
export const renderScheduled = (rows: readonly ScheduledNoteRow[]): ScheduledStatus[] =>
    rows.map((row) => ({
        id: row.id,
        scheduled_at: row.scheduled_at.toISOString(),
        params: {
            ...row.params,
            // As Mastodon has them once a status is scheduled.
            scheduled_at: null,
            idempotency: null,
            with_rate_limit: false,
        },
        media_attachments: [],
    }));
