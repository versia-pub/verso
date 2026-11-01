import { z } from "zod";
import { Account } from "./account.ts";

/** Why an account was reported. */
export const ReportCategory = z.enum(["spam", "legal", "violation", "other"]);
export type ReportCategory = z.infer<typeof ReportCategory>;

/**
 * A report of an account, and some of its statuses, to the instance's moderators.
 * @see https://docs.joinmastodon.org/entities/Report/
 */
export const Report = z.object({
    id: z.string(),
    /** Whether a moderator has dealt with it. */
    action_taken: z.boolean(),
    action_taken_at: z.iso.datetime().nullable(),
    category: ReportCategory,
    comment: z.string(),
    /** Whether it was sent on to the reported account's instance. */
    forwarded: z.boolean(),
    created_at: z.iso.datetime(),
    status_ids: z.array(z.string()).nullable(),
    /** The rules broken, from `/api/v1/instance/rules`, for a `violation`. */
    rule_ids: z.array(z.string()).nullable(),
    target_account: Account,
});
export type Report = z.infer<typeof Report>;
