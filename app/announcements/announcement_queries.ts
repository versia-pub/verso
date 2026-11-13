import type { Insertable, Selectable, Updateable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { AnnouncementsTable } from "./tables.ts";

export type AnnouncementRow = Selectable<AnnouncementsTable>;

export const insertAnnouncement = async (
    ctx: Context,
    row: Insertable<AnnouncementsTable>,
): Promise<void> => {
    await ctx.db.insertInto("announcements").values(row).execute();
};

export const findAnnouncement = (
    ctx: Context,
    id: string,
): Promise<AnnouncementRow | undefined> =>
    ctx.db.selectFrom("announcements").selectAll().where("id", "=", id).executeTakeFirst();

/** Changes the announcement `id`. Returns it as it is now, or `undefined` if there is none. */
export const updateAnnouncement = (
    ctx: Context,
    id: string,
    changes: Updateable<AnnouncementsTable>,
): Promise<AnnouncementRow | undefined> =>
    ctx.db.updateTable("announcements").set(changes).where("id", "=", id).returningAll()
        .executeTakeFirst();

/** Deletes the announcement `id`, and returns it, or `undefined` if there was none. */
export const deleteAnnouncement = (
    ctx: Context,
    id: string,
): Promise<AnnouncementRow | undefined> =>
    ctx.db.deleteFrom("announcements").where("id", "=", id).returningAll().executeTakeFirst();

/** Every announcement, the first made first. */
export const listAnnouncements = (ctx: Context): Promise<AnnouncementRow[]> =>
    ctx.db.selectFrom("announcements").selectAll().orderBy("id").execute();

/**
 * The published announcements, in the order their events start, or for those without an event, in
 * the order they were published.
 */
export const publishedAnnouncements = (ctx: Context): Promise<AnnouncementRow[]> =>
    ctx.db.selectFrom("announcements").selectAll()
        .where("published_at", "is not", null)
        .orderBy((eb) => eb.fn.coalesce("starts_at", "published_at"))
        .orderBy("id")
        .execute();

export const findPublishedAnnouncement = (
    ctx: Context,
    id: string,
): Promise<AnnouncementRow | undefined> =>
    ctx.db.selectFrom("announcements").selectAll()
        .where("id", "=", id)
        .where("published_at", "is not", null)
        .executeTakeFirst();

/** The ids of the unpublished announcements due to be published by `now`. */
export const dueAnnouncementIds = async (ctx: Context, now: Date): Promise<string[]> =>
    (await ctx.db.selectFrom("announcements").select("id")
        .where("published_at", "is", null)
        .where("scheduled_at", "<=", now)
        .execute()).map((row) => row.id);

/** The ids of the published announcements whose events ended by `now`. */
export const endedAnnouncementIds = async (ctx: Context, now: Date): Promise<string[]> =>
    (await ctx.db.selectFrom("announcements").select("id")
        .where("published_at", "is not", null)
        .where("ends_at", "<=", now)
        .execute()).map((row) => row.id);

/** Dismisses the announcement `announcementId` for `accountId`, unless they already did. */
export const insertDismissal = async (
    ctx: Context,
    accountId: string,
    announcementId: string,
): Promise<void> => {
    await ctx.db.insertInto("announcement_dismissals")
        .values({ account_id: accountId, announcement_id: announcementId })
        .onConflict((conflict) => conflict.columns(["account_id", "announcement_id"]).doNothing())
        .execute();
};

/** Of `announcementIds`, those `accountId` dismissed. */
export const dismissedAmong = async (
    ctx: Context,
    accountId: string,
    announcementIds: readonly string[],
): Promise<Set<string>> => {
    if (announcementIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("announcement_dismissals").select("announcement_id")
        .where("account_id", "=", accountId)
        .where("announcement_id", "in", announcementIds)
        .execute();
    return new Set(rows.map((row) => row.announcement_id));
};
