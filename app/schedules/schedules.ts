/**
 * Statuses that local users schedule, to be posted later, as Mastodon limits them.
 * @see https://docs.joinmastodon.org/methods/scheduled_statuses/
 * @module
 */
import { lockKey } from "../db/locking.ts";
import { Unprocessable } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { reserve } from "../media/attachments.ts";
import { type Draft, mediaOrPoll } from "../notes/notes.ts";
import { visibleOriginal } from "../notes/visibility.ts";
import {
    countScheduled,
    deleteScheduled,
    findScheduled,
    insertScheduled,
    type ScheduledNoteRow,
    setScheduledAt,
} from "./schedule_queries.ts";
import type { ScheduledParams } from "./tables.ts";

/** How soon a status may be scheduled for, at the earliest, as on Mastodon. */
const minimumOffsetMs = 5 * 60_000;

/** How many statuses one account may have scheduled, as on Mastodon. */
const totalLimit = 300;

/** How many statuses one account may have scheduled for one day, in UTC, as on Mastodon. */
const dailyLimit = 25;

const dayMs = 24 * 60 * 60_000;

/**
 * Refuses to schedule one of `accountId`'s statuses, other than `exceptId`, for `scheduledAt`, as
 * Mastodon does, and in its words: too soon, or past either limit.
 */
const checkSchedule = async (
    ctx: Context,
    accountId: string,
    scheduledAt: Date,
    exceptId: string | null,
) => {
    if (scheduledAt.getTime() <= ctx.clock.now().getTime() + minimumOffsetMs) {
        throw new Unprocessable("The scheduled date must be in the future");
    }
    if (await countScheduled(ctx, accountId, exceptId) >= totalLimit) {
        throw new Unprocessable(`You have exceeded the limit of ${totalLimit} scheduled posts`);
    }

    const from = new Date(Math.floor(scheduledAt.getTime() / dayMs) * dayMs);
    const until = new Date(from.getTime() + dayMs);
    if (await countScheduled(ctx, accountId, exceptId, { from, until }) >= dailyLimit) {
        throw new Unprocessable(
            `You have exceeded the limit of ${dailyLimit} scheduled posts for today`,
        );
    }
};

/**
 * Schedules a status by `accountId`, a local user, to be posted with `params` at `scheduledAt`, and
 * reserves its media until then. Returns `undefined` if the status it replies to doesn't exist or
 * `accountId` may not see it.
 */
export const scheduleNote = (
    ctx: Context,
    accountId: string,
    scheduledAt: Date,
    params: ScheduledParams,
): Promise<ScheduledNoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        // So that two at once can't both be within the limits.
        await lockKey(tx.db, `schedule:${accountId}`);

        // Each once, as they are reserved and attached.
        const mediaIds = [...new Set(params.media_ids ?? [])];
        mediaOrPoll(mediaIds.length > 0, params.poll !== null);
        const replyTo = params.in_reply_to_id;
        if (replyTo !== null && await visibleOriginal(tx, replyTo, accountId) === undefined) {
            return undefined;
        }
        await checkSchedule(tx, accountId, scheduledAt, null);

        const row: ScheduledNoteRow = {
            id: tx.ids(),
            account_id: accountId,
            scheduled_at: scheduledAt,
            params: { ...params, media_ids: mediaIds.length > 0 ? mediaIds : null },
            created_at: tx.clock.now(),
        };
        await insertScheduled(tx, row);
        await reserve(tx, accountId, row.id, mediaIds);
        return row;
    });

/**
 * Moves `accountId`'s scheduled status `id` to `scheduledAt`, within the limits, not counting the
 * status itself. Returns it, or `undefined` if they have no such status.
 */
export const reschedule = (
    ctx: Context,
    accountId: string,
    id: string,
    scheduledAt: Date,
): Promise<ScheduledNoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        await lockKey(tx.db, `schedule:${accountId}`);

        const row = await findScheduled(tx, accountId, id);
        if (row === undefined) return undefined;

        await checkSchedule(tx, accountId, scheduledAt, row.id);
        await setScheduledAt(tx, row.id, scheduledAt);
        return { ...row, scheduled_at: scheduledAt };
    });

/** Cancels `accountId`'s scheduled status `id`, and returns whether they had it. */
export const unschedule = async (ctx: Context, accountId: string, id: string): Promise<boolean> =>
    await findScheduled(ctx, accountId, id) !== undefined && await deleteScheduled(ctx, id);

/** The status that `params` say to post, with the author's defaults for what they leave out. */
export const draftOf = (params: ScheduledParams): Draft => ({
    text: params.text,
    format: params.content_type,
    spoilerText: params.spoiler_text,
    visibility: params.visibility ?? undefined,
    sensitive: params.sensitive ?? undefined,
    language: params.language ?? undefined,
    inReplyToId: params.in_reply_to_id ?? undefined,
    mediaIds: params.media_ids ?? [],
    poll: params.poll === null ? undefined : {
        options: params.poll.options,
        expiresIn: params.poll.expires_in,
        multiple: params.poll.multiple,
        hideTotals: params.poll.hide_totals,
    },
});
