import type { TextFormat } from "../accounts/tables.ts";
import type { Visibility } from "../kernel/visibility.ts";

/**
 * What a scheduled status will be posted with, as its author asked, with the fields of Mastodon's
 * `params` that can vary. Those left `null` are the author's defaults when it is posted.
 */
export type ScheduledParams = {
    readonly text: string;
    readonly content_type: TextFormat;
    readonly spoiler_text: string;
    readonly sensitive: boolean | null;
    readonly visibility: Visibility | null;
    readonly language: string | null;
    readonly in_reply_to_id: string | null;
    readonly media_ids: string[] | null;
    /** It runs for `expires_in` seconds from when the status is posted. */
    readonly poll: {
        readonly options: string[];
        readonly expires_in: number;
        readonly multiple: boolean;
        readonly hide_totals: boolean;
    } | null;
};

/** A status that a local user scheduled, which is posted when it is due. */
export type ScheduledNotesTable = {
    id: string;
    account_id: string;
    /** When it is posted. */
    scheduled_at: Date;
    params: ScheduledParams;
    created_at: Date;
};
