/**
 * Featured hashtags. Besides their own table, the queries read statuses and their hashtags
 * directly, so that each takes one query.
 * @module
 */
import type { Selectable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";
import type { FeaturedTagsTable } from "./tables.ts";

export type FeaturedTagRow = Selectable<FeaturedTagsTable>;

/** Has `accountId` feature the hashtag `name`, and returns it. */
export const insertFeaturedTag = async (
    ctx: Context,
    accountId: string,
    name: string,
): Promise<FeaturedTagRow> =>
    await ctx.db.insertInto("featured_tags")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            tag: name.toLowerCase(),
            name,
            created_at: ctx.clock.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

/** Has `accountId` stop featuring a hashtag. Returns whether it featured it. */
export const deleteFeaturedTag = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<boolean> =>
    (await ctx.db.deleteFrom("featured_tags")
        .where("account_id", "=", accountId)
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst()) !== undefined;

/** The hashtags `accountId` features, the earliest featured first. */
export const featuredTagsOf = async (ctx: Context, accountId: string): Promise<FeaturedTagRow[]> =>
    await ctx.db.selectFrom("featured_tags").selectAll()
        .where("account_id", "=", accountId)
        .orderBy("id")
        .execute();

/** The statuses of `accountId` that anyone may see with the hashtag `tag`, in lower case. */
const publiclyTagged = (ctx: Context, accountId: string, tag: string) =>
    ctx.db.selectFrom("notes")
        .innerJoin("note_tags", "note_tags.note_id", "notes.id")
        .where("notes.account_id", "=", accountId)
        .where("notes.visibility", "in", ["public", "unlisted"])
        .where("note_tags.name", "=", tag);

/**
 * How many statuses of `accountId` that anyone may see have the hashtag `tag`, in lower case, and
 * when the latest was posted.
 */
export const taggedStats = async (
    ctx: Context,
    accountId: string,
    tag: string,
): Promise<{ count: number; latest: Date | null }> => {
    const count = await publiclyTagged(ctx, accountId, tag).select(countAll)
        .executeTakeFirstOrThrow();
    const latest = await publiclyTagged(ctx, accountId, tag).select("notes.created_at")
        .orderBy("notes.id", "desc")
        .limit(1)
        .executeTakeFirst();

    return { count: readCount(count), latest: latest?.created_at ?? null };
};

/**
 * The hashtags of the latest `recent` statuses of `accountId` that it doesn't feature, the most
 * used first, in lower case.
 */
export const recentlyUsedTags = async (
    ctx: Context,
    accountId: string,
    recent: number,
    limit: number,
): Promise<string[]> => {
    const latest = ctx.db.selectFrom("notes").select("notes.id")
        .where("notes.account_id", "=", accountId)
        .orderBy("notes.id", "desc")
        .limit(recent);
    const featured = ctx.db.selectFrom("featured_tags").select("featured_tags.tag")
        .where("featured_tags.account_id", "=", accountId);

    const rows = await ctx.db.selectFrom("note_tags")
        .select("note_tags.name")
        .where("note_tags.note_id", "in", latest)
        .where("note_tags.name", "not in", featured)
        .groupBy("note_tags.name")
        .orderBy((eb) => eb.fn.countAll(), "desc")
        .orderBy("note_tags.name")
        .limit(limit)
        .execute();

    return rows.map((row) => row.name);
};
