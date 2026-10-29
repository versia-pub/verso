/**
 * Groups of notifications, as Mastodon's grouped notifications show them: pages of them, what each
 * shows, and the notifications and accounts in one.
 * @see https://docs.joinmastodon.org/methods/grouped_notifications/
 * @module
 */
import type { ExpressionBuilder } from "kysely";
import type { Database } from "../db/database.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import {
    filtered,
    type NotificationFilter,
    type NotificationRow,
    type Shown,
    shownQuery,
} from "./notification_queries.ts";
import type { NotificationType } from "./tables.ts";

/** Where a group's key is `ungrouped-<id>`, for a notification on its own. */
const ungrouped = "ungrouped-";

/**
 * The group a notification is in when only the types `grouped` are grouped: its stored one, or
 * else a group of its own.
 */
export const groupKeyOf = (row: NotificationRow, grouped: readonly NotificationType[]): string =>
    row.group_key !== null && grouped.includes(row.type) ? row.group_key : `${ungrouped}${row.id}`;

/**
 * A page of the groups of the notifications of `accountId`, newest first, as {@link shownQuery} and
 * `filter` allow, as one notification of each: the newest in the page, or the oldest after
 * `min_id`. `page.limit` counts groups, and only the types `grouped` are grouped.
 *
 * Mastodon finds them in one recursive query; Verso reads the page a part at a time, leaving out
 * the groups it has found, so that it works on SQLite too. Each part finds a group at least, and
 * reads twice as many notifications as the last, so that large groups, which a part may be full
 * of, take few parts.
 * @see https://github.com/mastodon/mastodon/blob/v4.3.0/app/models/notification.rb
 */
export const notificationGroupPage = async (
    ctx: Context,
    accountId: string,
    shown: Shown,
    filter: NotificationFilter,
    grouped: readonly NotificationType[],
    page: PageBounds,
): Promise<NotificationRow[]> => {
    if (filter.types?.length === 0) return [];

    const oldestFirst = page.min_id !== undefined;
    const found = new Map<string, NotificationRow>();
    let bounds = page;
    let size = page.limit;

    while (found.size < page.limit) {
        let query = filtered(ctx, accountId, shown, filter);
        if (found.size > 0) {
            // A key has its type in it, so this leaves in those of types that aren't grouped.
            const seen = [...found.keys()];
            query = query.where((eb) =>
                eb.or([eb("group_key", "is", null), eb("group_key", "not in", seen)])
            );
        }

        const part = await readPage(query, "notifications.id", { ...bounds, limit: size });
        // Read in the order the page goes, which is oldest first after `min_id`.
        const read = oldestFirst ? part.toReversed() : part;
        for (const row of read) {
            const key = groupKeyOf(row, grouped);
            if (!found.has(key) && found.size < page.limit) found.set(key, row);
        }

        const last = read.at(-1);
        if (last === undefined || part.length < size) break;
        size *= 2;
        bounds = oldestFirst ? { ...bounds, min_id: last.id } : { ...bounds, max_id: last.id };
    }

    const rows = [...found.values()];
    return oldestFirst ? rows.toReversed() : rows;
};

/** What a page shows of a group of notifications. */
export type GroupStats = {
    /** How many notifications it has, up to the newest of the page. */
    readonly count: number;
    /** Its oldest notification in the page. */
    readonly pageMinId: string;
    /**
     * Its newest notification from each of up to 8 accounts, newest first, up to the newest of the
     * page.
     */
    readonly samples: readonly Pick<NotificationRow, "id" | "from_account_id" | "created_at">[];
    /** The reactions of its 8 newest notifications, up to the newest of the page. */
    readonly reactionIds: readonly string[];
};

/** How many accounts, and reactions, a group's {@link GroupStats} has, as on Mastodon. */
const sampleSize = 8;

/**
 * The {@link GroupStats} of the groups `keys` of `accountId`'s notifications, in a page from
 * `oldest` to `newest`, counting only the notifications {@link shownQuery} allows.
 */
export const groupStatsOf = async (
    ctx: Context,
    accountId: string,
    shown: Shown,
    keys: readonly string[],
    page: { readonly oldest: string; readonly newest: string },
): Promise<Map<string, GroupStats>> => {
    if (keys.length === 0) return new Map();

    const inGroups = () =>
        shownQuery(ctx, accountId, shown)
            .where("group_key", "in", keys)
            .where("notifications.id", "<=", page.newest);

    const totals = await inGroups()
        .select((eb) => [
            "group_key",
            eb.fn.countAll<number | string | bigint>().as("count"),
            eb.fn.min(
                eb.case().when("notifications.id", ">=", page.oldest)
                    .then(eb.ref("notifications.id")).end(),
            ).as("page_min_id"),
        ])
        .groupBy("group_key")
        .execute();

    // Each account's newest, then the newest of those.
    const byAccount = inGroups()
        .select((eb) => [
            "notifications.id",
            "group_key",
            "from_account_id",
            "created_at",
            eb.fn.agg<number>("row_number")
                .over((ob) =>
                    ob.partitionBy(["group_key", "from_account_id"]).orderBy("id", "desc")
                )
                .as("rank"),
        ])
        .as("by_account");
    const samples = await ctx.db.selectFrom(
        ctx.db.selectFrom(byAccount)
            .select((eb) => [
                "id",
                "group_key",
                "from_account_id",
                "created_at",
                eb.fn.agg<number>("row_number")
                    .over((ob) => ob.partitionBy("group_key").orderBy("id", "desc"))
                    .as("sample"),
            ])
            .where("rank", "=", 1)
            .as("latest"),
    )
        .select(["id", "group_key", "from_account_id", "created_at"])
        .where("sample", "<=", sampleSize)
        .orderBy("id", "desc")
        .execute();

    const reactions = await ctx.db.selectFrom(
        inGroups()
            .select((eb) => [
                "notifications.id",
                "group_key",
                "reaction_id",
                eb.fn.agg<number>("row_number")
                    .over((ob) => ob.partitionBy("group_key").orderBy("id", "desc"))
                    .as("rank"),
            ])
            .as("ranked"),
    )
        .select(["group_key", "reaction_id"])
        .where("rank", "<=", sampleSize)
        .orderBy("id", "desc")
        .execute();

    return new Map(
        totals.flatMap((total): [string, GroupStats][] =>
            total.group_key === null || total.page_min_id === null ? [] : [[total.group_key, {
                count: Number(total.count),
                pageMinId: total.page_min_id,
                samples: samples.filter((sample) => sample.group_key === total.group_key),
                reactionIds: reactions.flatMap((reaction) =>
                    reaction.group_key === total.group_key && reaction.reaction_id !== null
                        ? [reaction.reaction_id]
                        : []
                ),
            }]]
        ),
    );
};

/**
 * Whether a notification is in the group `key`: has it as its stored key, or is the notification
 * that `ungrouped-<id>` names, even if it has a key, as when its type wasn't asked to be grouped.
 */
const inGroup = (key: string) => (eb: ExpressionBuilder<Database, "notifications">) =>
    key.startsWith(ungrouped)
        ? eb("notifications.id", "=", key.slice(ungrouped.length))
        : eb("notifications.group_key", "=", key);

/** The newest notification of `accountId`'s group `key` that {@link shownQuery} allows, if any. */
export const findGroupNotification = async (
    ctx: Context,
    accountId: string,
    key: string,
    shown: Shown,
): Promise<NotificationRow | undefined> =>
    await shownQuery(ctx, accountId, shown).selectAll()
        .where(inGroup(key))
        .orderBy("notifications.id", "desc")
        .limit(1)
        .executeTakeFirst();

/**
 * A page of the notifications of `accountId`'s group `key` that {@link shownQuery} allows, newest
 * first, as the newest of each account's, so that each account is on one page once.
 */
export const groupAccountPage = async (
    ctx: Context,
    accountId: string,
    key: string,
    shown: Shown,
    page: PageBounds,
): Promise<Pick<NotificationRow, "id" | "from_account_id">[]> => {
    let query = shownQuery(ctx, accountId, shown)
        .select(["notifications.id", "notifications.from_account_id"])
        .where(inGroup(key));

    // A notification on its own is the only one of its group.
    if (!key.startsWith(ungrouped)) {
        query = query.where((eb) =>
            eb.not(eb.exists(
                eb.selectFrom("notifications as newer").select("newer.id")
                    .where("newer.account_id", "=", accountId)
                    .where("newer.group_key", "=", key)
                    .where("newer.from_account_id", "=", eb.ref("notifications.from_account_id"))
                    .where("newer.id", ">", eb.ref("notifications.id")),
            ))
        );
    }

    return await readPage(query, "notifications.id", page);
};

/** Deletes the notifications of `accountId`'s group `key`. */
export const deleteGroup = async (ctx: Context, accountId: string, key: string): Promise<void> => {
    await ctx.db.deleteFrom("notifications")
        .where("account_id", "=", accountId)
        .where(inGroup(key))
        .execute();
};
