import { type SelectQueryBuilder, sql } from "kysely";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountPictures } from "./account_queries.ts";

/** Where a pass over remote accounts has got to: the last one it looked at. */
export type AccountPruneCursor = { readonly fetchedAt: Date; readonly id: string };

/**
 * The columns whose rows keep the account they refer to from being pruned, since deleting it would
 * delete or clear them: what local users did to or about it, and what it did that is still here.
 * Every other column that refers to accounts holds an account's own rows, or only local accounts'.
 */
export const keepingColumns = [
    ["account_notes", "target_id"],
    ["accounts", "moved_to_account_id"],
    ["blocks", "account_id"],
    ["blocks", "target_id"],
    ["endorsements", "target_id"],
    ["follows", "followee_id"],
    ["follows", "follower_id"],
    ["likes", "account_id"],
    ["list_accounts", "account_id"],
    ["mutes", "account_id"],
    ["mutes", "target_id"],
    ["note_mentions", "account_id"],
    ["notes", "account_id"],
    ["notes", "in_reply_to_account_id"],
    ["notification_permissions", "from_account_id"],
    ["notification_requests", "from_account_id"],
    ["notifications", "from_account_id"],
    ["poll_votes", "account_id"],
    ["reactions", "account_id"],
    ["reports", "account_id"],
    ["reports", "target_account_id"],
    ["suggestion_dismissals", "target_id"],
] as const;

/**
 * Up to `limit` remote accounts last fetched before `before`, after `after`, that could be pruned:
 * not suspended, silenced or bots, as on Mastodon. Exported for the tests of its query plan.
 */
export const oldRemoteAccountsQuery = (
    ctx: Context,
    before: Date,
    after: AccountPruneCursor | undefined,
    limit: number,
): SelectQueryBuilder<Database, "accounts", { id: string; fetched_at: Date | null }> => {
    let query = ctx.db.selectFrom("accounts").select(["id", "fetched_at"])
        .where("instance_id", "is not", null)
        .where("fetched_at", "<", before);
    if (after) {
        query = query.where((eb) =>
            eb(eb.refTuple("fetched_at", "id"), ">", eb.tuple(after.fetchedAt, after.id))
        );
    }

    return query.orderBy("fetched_at").orderBy("id").limit(limit);
};

/**
 * Which of the accounts `ids`, at least one, nothing refers to by {@link keepingColumns}, and that
 * aren't suspended, silenced or bots, with their pictures.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/lib/mastodon/cli/accounts.rb
 */
export const prunableAccountsQuery = (
    ctx: Context,
    ids: readonly string[],
): SelectQueryBuilder<Database, "accounts", AccountPictures> =>
    ctx.db.selectFrom("accounts").select(["id", "avatar_id", "header_id"])
        .where("id", "in", ids)
        .where("suspended_at", "is", null)
        .where("silenced_at", "is", null)
        .where("bot", "=", false)
        .where((eb) =>
            eb.not(
                eb.or(keepingColumns.map(([table, column]) =>
                    // Aliased, so that the accounts that keep one aren't the one looked at.
                    sql<boolean>`exists (select 1 from ${sql.table(table)} as keeping where ${
                        sql.ref(`keeping.${column}`)
                    } = ${sql.ref("accounts.id")})`
                )),
            )
        );
