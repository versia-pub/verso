import { z } from "zod";
import { Visibility } from "./account.ts";
import { MediaAttachment } from "./media_attachment.ts";

/**
 * A status that will be posted later.
 * @see https://docs.joinmastodon.org/entities/ScheduledStatus/
 */
export const ScheduledStatus = z.object({
    id: z.string(),
    /** When it will be posted. */
    scheduled_at: z.iso.datetime(),
    /** What it will be posted with, as it was scheduled. What is `null` is the author's default. */
    params: z.object({
        text: z.string(),
        /** Verso's own: how the text is written. */
        content_type: z.enum(["text/plain", "text/markdown"]).optional(),
        poll: z.object({
            options: z.array(z.string()),
            /** How long it runs from when the status is posted, in seconds. */
            expires_in: z.union([z.int(), z.string()]),
            multiple: z.boolean().optional(),
            hide_totals: z.boolean().optional(),
        }).nullable(),
        media_ids: z.array(z.string()).nullable(),
        sensitive: z.boolean().nullable(),
        spoiler_text: z.string().nullable(),
        visibility: Visibility.nullable(),
        in_reply_to_id: z.string().nullable(),
        language: z.string().nullable(),
        scheduled_at: z.null(),
        idempotency: z.string().nullable(),
        with_rate_limit: z.boolean(),
    }),
    media_attachments: z.array(MediaAttachment),
});
export type ScheduledStatus = z.infer<typeof ScheduledStatus>;
