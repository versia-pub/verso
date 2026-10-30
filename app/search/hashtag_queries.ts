/**
 * Finding hashtags, and how much they were used. Its queries read the hashtags, the hashtags
 * statuses use, and the statuses, directly.
 * @module
 */
import { type Expression, sql, type SqlBool } from "kysely";
import { usesSqlite } from "../db/columns.ts";
import type { Context } from "../kernel/context.ts";
import { firstIdAt } from "../kernel/ids.ts";

/**
 * Whether a hashtag's name starts with `start`, in a way its index finds. SQLite's `LIKE` ignores
 * case, which its index can't, so SQLite uses `GLOB`. Wildcards in `start` are themselves, as `_`,
 * common in hashtags, must be.
 */
const startsWith = (ctx: Pick<Context, "db">, start: string): Expression<SqlBool> => {
    if (usesSqlite(ctx.db)) {
        const pattern = `${start.replaceAll(/[*?[]/g, (character) => `[${character}]`)}*`;
        return sql<SqlBool>`tags.name GLOB ${pattern}`;
    }

    const pattern = `${start.replaceAll(/[\\%_]/g, (character) => `\\${character}`)}%`;
    return sql<SqlBool>`tags.name LIKE ${pattern} ESCAPE '\\'`;
};

/**
 * Up to `limit` hashtags, after the first `offset`, that start with `start` and are used by a
 * public or unlisted status, shortest first, as Mastodon lists them. Hashtags used only where few
 * can see them stay unknown.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/tag.rb
 */
export const hashtagsStartingWith = async (
    ctx: Pick<Context, "db">,
    start: string,
    limit: number,
    offset: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("tags")
        .select("tags.name")
        .where(startsWith(ctx, start))
        .where(({ exists, selectFrom }) =>
            exists(
                selectFrom("note_tags")
                    .innerJoin("notes", "notes.id", "note_tags.note_id")
                    .select("note_tags.note_id")
                    .whereRef("note_tags.name", "=", "tags.name")
                    .where("notes.visibility", "in", ["public", "unlisted"]),
            )
        )
        .orderBy(sql`length(tags.name)`)
        .orderBy("tags.name")
        .limit(limit)
        .offset(offset)
        .execute();

    return rows.map((row) => row.name);
};

/** How many statuses used a hashtag on one of the days asked about, and how many accounts. */
export type HashtagDay = {
    readonly name: string;
    /** Which of the days. */
    readonly day: number;
    readonly uses: number;
    readonly accounts: number;
};

/**
 * How public and unlisted statuses used each of `names` on each of the days that start at `days`,
 * newest first, each a day long, as Mastodon counts its uses. Days they weren't used are left out.
 *
 * Only statuses whose ids are from the oldest day on are counted, so that the hashtags' index
 * reads only those, not every use there ever was. Ids have the time a status was made, except a
 * remote status dated after it arrived, whose id has when it arrived, so one of those that arrived
 * before the oldest day isn't counted.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/trends/tags.rb
 */
export const hashtagUses = async (
    ctx: Pick<Context, "db">,
    names: readonly string[],
    days: readonly Date[],
): Promise<HashtagDay[]> => {
    const newest = days.at(0);
    const oldest = days.at(-1);
    if (names.length === 0 || newest === undefined || oldest === undefined) return [];

    // Which of `days` a status is from, by the newest it is after.
    const day = sql<number>`CASE ${
        sql.join(
            days.map((start, i) => sql`WHEN notes.created_at >= ${start} THEN ${sql.lit(i)}`),
            sql` `,
        )
    } END`;
    const rows = await ctx.db.selectFrom("note_tags")
        .innerJoin("notes", "notes.id", "note_tags.note_id")
        .select((eb) => [
            "note_tags.name",
            day.as("day"),
            eb.fn.countAll<number | string | bigint>().as("uses"),
            eb.fn.count<number | string | bigint>("notes.account_id").distinct().as("accounts"),
        ])
        .where("note_tags.name", "in", names)
        .where("note_tags.note_id", ">=", firstIdAt(oldest))
        .where("notes.visibility", "in", ["public", "unlisted"])
        .where("notes.created_at", ">=", oldest)
        .where("notes.created_at", "<", new Date(newest.getTime() + 24 * 60 * 60 * 1000))
        .groupBy(["note_tags.name", sql`day`])
        .execute();

    return rows.map((row) => ({
        name: row.name,
        day: Number(row.day),
        uses: Number(row.uses),
        accounts: Number(row.accounts),
    }));
};
