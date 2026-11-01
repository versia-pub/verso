import type { ReportCategory } from "@versia/client-api";

/** A report of an account, and some of its statuses, to the instance's moderators. */
export type ReportsTable = {
    id: string;
    /** The local user who reported it, or `null` once their account is deleted. */
    account_id: string | null;
    target_account_id: string;
    category: ReportCategory;
    comment: string;
    /** The reported statuses, which may since have been deleted. */
    note_ids: string[];
    /** The rules broken, by their ids in `/api/v1/instance/rules`, for a `violation`. */
    rule_ids: string[] | null;
    /** Whether it was sent on to the reported account's instance. */
    forwarded: boolean;
    created_at: Date;
    /** When a moderator dealt with it, or `null` until then. */
    resolved_at: Date | null;
};
