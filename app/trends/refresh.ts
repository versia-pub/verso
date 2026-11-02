/**
 * Working out what is trending. Hashtags are scored by how many accounts used them today compared
 * with yesterday, statuses by how many times they were liked and boosted, as Mastodon does.
 * Whether admins approved them is checked when they are shown, so approving takes effect at once.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { hashtagUses } from "../search/hashtag_queries.ts";
import {
    dayMs,
    decayed,
    peakCooldownMs,
    peakHalfLifeMs,
    statusDecayThreshold,
    statusScore,
    statusThreshold,
    tagDecayThreshold,
    tagScore,
    tagThreshold,
} from "./scoring.ts";
import {
    hashtagsUsedBy,
    replaceTrendingStatuses,
    replaceTrendingTags,
    statusCandidates,
    type TrendingStatus,
    type TrendingTag,
    trendingTags,
} from "./trend_queries.ts";

/** The queue the scheduler enqueues a refresh in. */
export const trendsQueue = "trends";

/**
 * Scores the hashtags that accounts used today, and those already trending, and keeps those whose
 * decayed peak is still high enough. A hashtag's peak is remembered for two days, and halves every
 * four hours.
 */
export const refreshTrendingTags = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();
    const today = new Date(Math.floor(now.getTime() / dayMs) * dayMs);
    const yesterday = new Date(today.getTime() - dayMs);

    const existing = new Map((await trendingTags(ctx)).map((row) => [row.name, row]));
    const names = [
        ...new Set([...await hashtagsUsedBy(ctx, today, tagThreshold), ...existing.keys()]),
    ];

    // Only public statuses count, as on Mastodon.
    const uses = new Map(
        (await hashtagUses(ctx, names, [today, yesterday], ["public"]))
            .map((used) => [`${used.name} ${used.day}`, used.accounts]),
    );

    const trending: TrendingTag[] = [];
    for (const name of names) {
        const score = tagScore(uses.get(`${name} 0`) ?? 0, uses.get(`${name} 1`) ?? 0);

        const before = existing.get(name);
        const stale = before === undefined ||
            before.max_score_at.getTime() < now.getTime() - peakCooldownMs;
        let peak = stale
            ? { score: 0, at: now }
            : { score: before.max_score, at: before.max_score_at };
        if (score > peak.score) peak = { score, at: now };

        const current = decayed(peak.score, now.getTime() - peak.at.getTime(), peakHalfLifeMs);
        if (current >= tagDecayThreshold) {
            trending.push({
                name,
                score: current,
                max_score: peak.score,
                max_score_at: peak.at,
            });
        }
    }

    await replaceTrendingTags(ctx, trending);
};

/** How far back a status can have been posted and still trend, as its score halves every hour. */
const statusWindowMs = 2 * dayMs;

/**
 * Scores the statuses liked and boosted enough lately, and keeps those whose score, decayed by
 * their age, is high enough, and for each author the best.
 */
export const refreshTrendingStatuses = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();
    const candidates = await statusCandidates(
        ctx,
        new Date(now.getTime() - statusWindowMs),
        statusThreshold,
    );

    const best = new Map<string, TrendingStatus>();
    for (const candidate of candidates) {
        const score = statusScore(candidate.interactions, candidate.created_at, now);
        if (score < statusDecayThreshold) continue;

        const other = best.get(candidate.account_id);
        if (
            other === undefined || score > other.score ||
            (score === other.score && candidate.id > other.note_id)
        ) {
            best.set(candidate.account_id, {
                note_id: candidate.id,
                account_id: candidate.account_id,
                score,
            });
        }
    }

    await replaceTrendingStatuses(ctx, [...best.values()]);
};

/** Works out what is trending. */
export const refreshTrends = async (ctx: Context): Promise<void> => {
    await refreshTrendingTags(ctx);
    await refreshTrendingStatuses(ctx);
};
