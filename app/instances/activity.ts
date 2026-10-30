/**
 * How active the instance has been, week by week, as Mastodon reports it.
 * @see https://docs.joinmastodon.org/methods/instance/#activity
 * @module
 */
import type { WeeklyActivity } from "@versia/client-api";
import { countLocalAccountsCreated } from "../accounts/account_queries.ts";
import { countAccountsWithTokensSince } from "../auth/token_queries.ts";
import type { Context } from "../kernel/context.ts";
import { countLocalNotesPosted } from "../notes/note_queries.ts";

/** How many weeks Mastodon reports, the current one included. */
const weeks = 12;

const dayMs = 24 * 60 * 60 * 1000;

/** Midnight UTC on the Monday that starts the week of `time`. */
export const weekStart = (time: Date): Date => {
    const midnight = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
    const sinceMonday = (time.getUTCDay() + 6) % 7;

    return new Date(midnight - sinceMonday * dayMs);
};

/**
 * Each of the last 12 weeks, the current one first: how many statuses local users posted, how many
 * of them logged in, as access tokens they were issued show, and how many accounts were created.
 */
export const weeklyActivity = async (ctx: Context): Promise<WeeklyActivity[]> => {
    const current = weekStart(ctx.clock.now()).getTime();
    const activity: WeeklyActivity[] = [];

    // One week at a time, so the counts don't take many of the pool's connections at once.
    for (let index = 0; index < weeks; index++) {
        const since = new Date(current - index * 7 * dayMs);
        const until = new Date(since.getTime() + 7 * dayMs);

        activity.push({
            week: String(since.getTime() / 1000),
            statuses: String(await countLocalNotesPosted(ctx, since, until)),
            logins: String(await countAccountsWithTokensSince(ctx, since, until)),
            registrations: String(await countLocalAccountsCreated(ctx, since, until)),
        });
    }

    return activity;
};
