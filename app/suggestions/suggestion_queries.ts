/**
 * Queries for follow suggestions. Some read `accounts`, and the graph module's `follows`, directly,
 * so each takes one query.
 * @module
 */
import { sql } from "kysely";
import { countAll } from "../db/count.ts";
import { type Filter, notExcluded } from "../graph/excluded_queries.ts";
import { blockerIdsQuery } from "../graph/block_queries.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";

/** Stops suggesting `targetId` to `accountId`, if it didn't already. */
export const insertDismissal = async (
    ctx: Context,
    accountId: string,
    targetId: string,
): Promise<void> => {
    await ctx.db.insertInto("suggestion_dismissals")
        .values({ account_id: accountId, target_id: targetId, created_at: ctx.clock.now() })
        .onConflict((conflict) => conflict.columns(["account_id", "target_id"]).doNothing())
        .execute();
};

/**
 * Whether the account of `table`, an alias of `accounts`, could be suggested to `viewerId`: it
 * isn't them, and isn't followed or requested by them, hidden from them, blocking them or dismissed
 * by them. Local accounts must be discoverable, while remote ones, which have no such setting,
 * always are. As on Mastodon, suspended and silenced accounts, and those that moved, aren't.
 */
const suggestible = (ctx: Context, viewerId: string, table: string): Filter => (eb) => {
    const id = sql.ref<string>(`${table}.id`);
    const dismissed = ctx.db.selectFrom("suggestion_dismissals")
        .select("target_id")
        .where("account_id", "=", viewerId);
    const followed = ctx.db.selectFrom("follows")
        .select("followee_id")
        .where("follower_id", "=", viewerId);

    return eb.and([
        eb.or([
            eb(sql.ref<string | null>(`${table}.instance_id`), "is not", null),
            eb(sql.ref<boolean>(`${table}.discoverable`), "=", true),
        ]),
        eb(sql.ref<Date | null>(`${table}.suspended_at`), "is", null),
        eb(sql.ref<Date | null>(`${table}.silenced_at`), "is", null),
        eb(sql.ref<string | null>(`${table}.moved_to_account_id`), "is", null),
        eb(id, "<>", viewerId),
        eb(id, "not in", followed),
        eb(id, "not in", dismissed),
        eb(id, "not in", blockerIdsQuery(ctx, viewerId)),
        notExcluded(hiddenFrom(ctx, viewerId), `${table}.id`)(eb),
    ]);
};

/** Which of `ids` could be suggested to `viewerId`, in the order of `ids`. */
export const suggestibleAmong = async (
    ctx: Context,
    viewerId: string,
    ids: readonly string[],
): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("accounts")
        .select("accounts.id")
        .where("accounts.id", "in", ids)
        .where(suggestible(ctx, viewerId, "accounts"))
        .execute();
    const found = new Set(rows.map((row) => row.id));

    return ids.filter((id) => found.has(id));
};

/**
 * Up to `limit` accounts that the accounts `viewerId` follows follow, and that could be suggested
 * to them, the ones followed by most of them first, then the ones with fewest followers. Those who
 * hide their follows aren't counted, as on Mastodon.
 */
export const friendsOfFriends = async (
    ctx: Context,
    viewerId: string,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("follows as mine")
        .innerJoin("follows as theirs", "theirs.follower_id", "mine.followee_id")
        .innerJoin("accounts as friend", "friend.id", "mine.followee_id")
        .innerJoin("accounts as candidate", "candidate.id", "theirs.followee_id")
        .select(["candidate.id", countAll])
        .where("mine.follower_id", "=", viewerId)
        .where("mine.accepted", "=", true)
        .where("theirs.accepted", "=", true)
        .where("friend.hide_collections", "=", false)
        .where(suggestible(ctx, viewerId, "candidate"))
        .groupBy(["candidate.id", "candidate.followers_count"])
        .orderBy("count", "desc")
        .orderBy("candidate.followers_count")
        .orderBy("candidate.id")
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};
