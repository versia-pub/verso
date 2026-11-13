/**
 * What is trending, and which hashtags and accounts may trend. Its queries read the trending
 * tables, the hashtags, the statuses and their authors directly.
 * @module
 */
import type { Selectable, SqlBool } from "kysely";
import { sql } from "kysely";
import { notExcluded, notSuspendedOrSilenced } from "../graph/excluded_queries.ts";
import { blockerIdsQuery } from "../graph/block_queries.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { firstIdAt } from "../kernel/ids.ts";
import type { NoteRow } from "../notes/note_queries.ts";
import { replaceRows } from "./replace.ts";
import type { TrendingStatusesTable, TrendingTagsTable } from "./tables.ts";

export type TrendingTag = Selectable<TrendingTagsTable>;
export type TrendingStatus = Selectable<TrendingStatusesTable>;

/**
 * Whether an admin approved the hashtag or account whose `trendable` is in `column`, or hasn't
 * decided and `byDefault` approves it.
 */
const approved = (column: "tags.trendable" | "accounts.trendable", byDefault: boolean) => {
    const trendable = sql.ref(column);

    return byDefault
        ? sql<SqlBool>`(${trendable} is null or ${trendable} = true)`
        : sql<SqlBool>`${trendable} = true`;
};

/** The hashtags that are trending, approved or not. */
export const trendingTags = async (ctx: Context): Promise<TrendingTag[]> =>
    await ctx.db.selectFrom("trending_tags").selectAll().execute();

/**
 * The hashtags that at least `accounts` accounts used in public statuses, not boosts, since
 * `since`. Suspended and silenced accounts' statuses don't count.
 */
export const hashtagsUsedBy = async (
    ctx: Context,
    since: Date,
    accounts: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("note_tags")
        .innerJoin("notes", "notes.id", "note_tags.note_id")
        .select("note_tags.name")
        .where("note_tags.note_id", ">=", firstIdAt(since))
        .where("notes.visibility", "=", "public")
        .where("notes.reblog_of_id", "is", null)
        .where("notes.created_at", ">=", since)
        .where(notSuspendedOrSilenced(ctx, "notes.account_id"))
        .groupBy("note_tags.name")
        .having((eb) => eb(eb.fn.count("notes.account_id").distinct(), ">=", accounts))
        .execute();

    return rows.map((row) => row.name);
};

/** Makes `rows` the hashtags that are trending, and no others. */
export const replaceTrendingTags = async (
    ctx: Context,
    rows: readonly TrendingTag[],
): Promise<void> => {
    await replaceRows({
        rows,
        keyOf: (row) => row.name,
        stored: (await ctx.db.selectFrom("trending_tags").select("name").execute())
            .map((row) => row.name),
        remove: (names) => ctx.db.deleteFrom("trending_tags").where("name", "in", names).execute(),
        upsert: (batch) =>
            ctx.db.insertInto("trending_tags")
                .values(batch)
                .onConflict((conflict) =>
                    conflict.column("name").doUpdateSet((eb) => ({
                        score: eb.ref("excluded.score"),
                        max_score: eb.ref("excluded.max_score"),
                        max_score_at: eb.ref("excluded.max_score_at"),
                    }))
                )
                .execute(),
    });
};

/**
 * The names of the trending hashtags that may be shown, the highest scoring first: those an admin
 * approved, and unless one rejected them, all if `byDefault`. Skips the first `offset`.
 */
export const approvedTrendingTags = async (
    ctx: Context,
    byDefault: boolean,
    limit: number,
    offset: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("trending_tags")
        .innerJoin("tags", "tags.name", "trending_tags.name")
        .select("trending_tags.name")
        .where(approved("tags.trendable", byDefault))
        .orderBy("trending_tags.score", "desc")
        .orderBy("trending_tags.name")
        .limit(limit)
        .offset(offset)
        .execute();

    return rows.map((row) => row.name);
};

/** A status that could be trending: how many times it was liked and boosted, and when it began. */
export type StatusCandidate = {
    readonly id: string;
    readonly account_id: string;
    readonly created_at: Date;
    readonly interactions: number;
};

/**
 * The statuses since `since` that could trend, with at least `interactions` likes and boosts:
 * public ones, but not boosts, replies or ones that are sensitive or have a content warning. Their
 * authors are local accounts that are discoverable or remote accounts, which have no say in it, and
 * aren't suspended or silenced.
 */
export const statusCandidates = async (
    ctx: Context,
    since: Date,
    interactions: number,
): Promise<StatusCandidate[]> => {
    const total = sql<number | string>`notes.likes_count + notes.shares_count`;
    const rows = await ctx.db.selectFrom("notes")
        .innerJoin("accounts", "accounts.id", "notes.account_id")
        .select(["notes.id", "notes.account_id", "notes.created_at", total.as("interactions")])
        .where("notes.id", ">=", firstIdAt(since))
        .where("notes.created_at", ">=", since)
        .where("notes.visibility", "=", "public")
        .where("notes.reblog_of_id", "is", null)
        .where("notes.in_reply_to_id", "is", null)
        .where("notes.spoiler_text", "=", "")
        .where("notes.sensitive", "=", false)
        .where((eb) =>
            eb.or([
                eb("accounts.instance_id", "is not", null),
                eb("accounts.discoverable", "=", true),
            ])
        )
        .where("accounts.suspended_at", "is", null)
        .where("accounts.silenced_at", "is", null)
        .where(sql<boolean>`${total} >= ${interactions}`)
        .execute();

    return rows.map((row) => ({ ...row, interactions: Number(row.interactions) }));
};

/** Makes `rows` the statuses that are trending, and no others. */
export const replaceTrendingStatuses = async (
    ctx: Context,
    rows: readonly TrendingStatus[],
): Promise<void> => {
    await replaceRows({
        rows,
        keyOf: (row) => row.note_id,
        stored: (await ctx.db.selectFrom("trending_statuses").select("note_id").execute())
            .map((row) => row.note_id),
        remove: (ids) =>
            ctx.db.deleteFrom("trending_statuses").where("note_id", "in", ids).execute(),
        upsert: (batch) =>
            ctx.db.insertInto("trending_statuses")
                .values(batch)
                .onConflict((conflict) =>
                    conflict.column("note_id").doUpdateSet((eb) => ({
                        account_id: eb.ref("excluded.account_id"),
                        score: eb.ref("excluded.score"),
                    }))
                )
                .execute(),
    });
};

/**
 * A page of the trending statuses that may be shown, the highest scoring first, skipping the first
 * `offset`: those whose authors an admin approved, and unless one rejected them, all if
 * `byDefault`. A viewer, `viewerId`, doesn't see those of accounts they block or mute, or that
 * block them.
 */
export const approvedTrendingStatuses = async (
    ctx: Context,
    byDefault: boolean,
    viewerId: string | null,
    limit: number,
    offset: number,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("trending_statuses")
        .innerJoin("notes", "notes.id", "trending_statuses.note_id")
        .innerJoin("accounts", "accounts.id", "notes.account_id")
        .selectAll("notes")
        .where(approved("accounts.trendable", byDefault))
        .where("notes.visibility", "=", "public")
        // Mastodon drops a suspended account's statuses from trends at once.
        .where("accounts.suspended_at", "is", null);

    if (viewerId !== null) {
        query = query
            .where(notExcluded(hiddenFrom(ctx, viewerId), "notes.account_id"))
            .where("notes.account_id", "not in", blockerIdsQuery(ctx, viewerId));
    }

    return await query
        .orderBy("trending_statuses.score", "desc")
        .orderBy("notes.id", "desc")
        .limit(limit)
        .offset(offset)
        .execute();
};

/** Sets whether the hashtag `name` may trend. Returns `false` if it isn't known. */
export const setTagTrendable = async (
    ctx: Context,
    name: string,
    trendable: boolean,
): Promise<boolean> => {
    const result = await ctx.db.updateTable("tags")
        .set({ trendable })
        .where("name", "=", name.toLowerCase())
        .executeTakeFirst();

    return result.numUpdatedRows > 0n;
};

/** Sets whether the statuses of the account `accountId` may trend. */
export const setAccountTrendable = async (
    ctx: Context,
    accountId: string,
    trendable: boolean,
): Promise<void> => {
    await ctx.db.updateTable("accounts").set({ trendable }).where("id", "=", accountId).execute();
};

/** A trending hashtag, for an admin to review. */
export type TrendingTagForAdmin = {
    readonly name: string;
    readonly score: number;
    readonly trendable: boolean | null;
};

/** The trending hashtags, the highest scoring first, with what admins decided. */
export const trendingTagsForAdmin = async (ctx: Context): Promise<TrendingTagForAdmin[]> =>
    await ctx.db.selectFrom("trending_tags")
        .innerJoin("tags", "tags.name", "trending_tags.name")
        .select(["trending_tags.name", "trending_tags.score", "tags.trendable"])
        .orderBy("trending_tags.score", "desc")
        .orderBy("trending_tags.name")
        .execute();

/** An account with a trending status, for an admin to review. */
export type TrendingAccountForAdmin = {
    readonly id: string;
    readonly username: string;
    /** `null` for a local account. */
    readonly domain: string | null;
    /** The score of its best status. */
    readonly score: number;
    readonly trendable: boolean | null;
};

/** The accounts with trending statuses, the highest scoring first, with what admins decided. */
export const trendingAccountsForAdmin = async (
    ctx: Context,
): Promise<TrendingAccountForAdmin[]> => {
    const rows = await ctx.db.selectFrom("trending_statuses")
        .innerJoin("accounts", "accounts.id", "trending_statuses.account_id")
        .leftJoin("instances", "instances.id", "accounts.instance_id")
        .select((eb) => [
            "accounts.id",
            "accounts.username",
            "instances.domain",
            eb.fn.max("trending_statuses.score").as("score"),
            "accounts.trendable",
        ])
        .groupBy(["accounts.id", "accounts.username", "instances.domain", "accounts.trendable"])
        .execute();

    return rows.map((row) => ({ ...row, score: Number(row.score) }))
        .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};
