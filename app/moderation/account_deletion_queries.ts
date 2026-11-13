import { sql } from "kysely";
import type { Context } from "../kernel/context.ts";

/**
 * The columns referring to an account whose rows are deleted when it is kept as a deleted account.
 * The order deletes rows before what they refer to. Its media and emojis are deleted separately.
 */
export const purgedColumns = [
    ["access_tokens", "account_id"],
    ["oauth_flows", "account_id"],
    ["push_subscriptions", "account_id"],
    ["markers", "account_id"],
    ["web_preferences", "account_id"],
    ["account_roles", "account_id"],
    ["account_domain_blocks", "account_id"],
    ["account_emojis", "account_id"],
    ["account_notes", "account_id"],
    ["account_notes", "target_id"],
    ["account_search", "account_id"],
    ["announcement_dismissals", "account_id"],
    ["announcement_reactions", "account_id"],
    ["blocks", "account_id"],
    ["blocks", "target_id"],
    ["mutes", "account_id"],
    ["mutes", "target_id"],
    ["bookmarks", "account_id"],
    ["conversations", "account_id"],
    ["endorsements", "account_id"],
    ["endorsements", "target_id"],
    ["featured_tags", "account_id"],
    ["filters", "account_id"],
    ["follows", "follower_id"],
    ["follows", "followee_id"],
    ["likes", "account_id"],
    ["reactions", "account_id"],
    ["list_accounts", "account_id"],
    ["lists", "account_id"],
    ["notifications", "account_id"],
    ["notifications", "from_account_id"],
    ["notification_permissions", "account_id"],
    ["notification_permissions", "from_account_id"],
    ["notification_policies", "account_id"],
    ["notification_requests", "account_id"],
    ["notification_requests", "from_account_id"],
    ["note_pins", "account_id"],
    ["trending_statuses", "account_id"],
    ["notes", "account_id"],
    ["scheduled_notes", "account_id"],
    ["suggestion_dismissals", "account_id"],
    ["suggestion_dismissals", "target_id"],
    ["tag_follows", "account_id"],
    ["thread_mutes", "account_id"],
] as const;

/**
 * The columns referring to an account whose rows are kept when it is kept as a deleted account:
 * - its login, so it can't sign up again
 * - the reports by and about it, and those it resolved
 * - its poll votes, so polls keep their counts
 * - others' statuses mentioning or replying to it
 * - the accounts that moved to it
 */
export const keptColumns = [
    ["identities", "account_id"],
    ["reports", "account_id"],
    ["reports", "target_account_id"],
    ["reports", "resolved_by_account_id"],
    ["poll_votes", "account_id"],
    ["note_mentions", "account_id"],
    ["notes", "in_reply_to_account_id"],
    ["accounts", "moved_to_account_id"],
] as const;

/** Deletes the rows of {@link purgedColumns} that refer to `accountId`. */
export const purgeRowsOf = async (ctx: Context, accountId: string): Promise<void> => {
    for (const [table, column] of purgedColumns) {
        await sql`delete from ${sql.table(table)} where ${sql.ref(column)} = ${accountId}`
            .execute(ctx.db);
    }
};
