import { z } from "zod";
import { Account } from "./account.ts";
import { Rule } from "./instance.ts";
import { ReportCategory } from "./report.ts";
import { Role } from "./role.ts";
import { Status } from "./status.ts";

/**
 * An IP address an account's user signed in from.
 * @see https://docs.joinmastodon.org/entities/Admin_Ip/
 */
export const AdminIp = z.object({
    ip: z.string(),
    used_at: z.iso.datetime(),
});
export type AdminIp = z.infer<typeof AdminIp>;

/**
 * An account as moderators see it. Verso doesn't keep users' emails, IP addresses, locales or
 * sign-up reasons, so those are always `null` or empty, and every local user is confirmed and
 * approved, and never disabled or marked sensitive.
 * @see https://docs.joinmastodon.org/entities/Admin_Account/
 */
export const AdminAccount = z.object({
    id: z.string(),
    username: z.string(),
    /** The account's instance, or `null` for a local account. */
    domain: z.string().nullable(),
    created_at: z.iso.datetime(),
    email: z.string().nullable(),
    ip: z.string().nullable(),
    ips: z.array(AdminIp),
    locale: z.string().nullable(),
    invite_request: z.string().nullable(),
    /** The user's highest role, or `null` for a remote account. */
    role: Role.nullable(),
    /** `null` for a remote account. */
    confirmed: z.boolean().nullable(),
    /** `null` for a remote account. */
    approved: z.boolean().nullable(),
    /** `null` for a remote account. */
    disabled: z.boolean().nullable(),
    silenced: z.boolean(),
    suspended: z.boolean(),
    sensitized: z.boolean(),
    account: Account,
});
export type AdminAccount = z.infer<typeof AdminAccount>;

/**
 * A report as moderators see it. Verso doesn't assign reports to moderators.
 * @see https://docs.joinmastodon.org/entities/Admin_Report/
 */
export const AdminReport = z.object({
    id: z.string(),
    /** Whether a moderator has resolved it. */
    action_taken: z.boolean(),
    action_taken_at: z.iso.datetime().nullable(),
    category: ReportCategory,
    comment: z.string(),
    /** Whether it was sent on to the reported account's instance. */
    forwarded: z.boolean(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    /**
     * Who filed it, or, unlike on Mastodon, `null` for a report from another instance and once the
     * reporter's account is deleted.
     */
    account: AdminAccount.nullable(),
    target_account: AdminAccount,
    assigned_account: AdminAccount.nullable(),
    /** Who resolved it, if they did so through the admin API. */
    action_taken_by_account: AdminAccount.nullable(),
    /** The reported statuses that still exist. */
    statuses: z.array(Status),
    /** The rules broken, for a `violation`. */
    rules: z.array(Rule),
});
export type AdminReport = z.infer<typeof AdminReport>;
