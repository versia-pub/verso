/**
 * Working out what is trending. Hashtags and links are scored by how many accounts used them today
 * compared with yesterday, statuses by how many times they were liked and boosted, as Mastodon
 * does.
 * Whether admins approved them is checked when they are shown, so approving takes effect at once.
 * @module
 */
import { dayMs } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { hashtagUses } from "../search/hashtag_queries.ts";
import {
    cardsSharedBy,
    linkUses,
    replaceTrendingLinks,
    type TrendingLink,
    trendingLinks,
} from "./link_queries.ts";
import {
    decayed,
    linkDecayThreshold,
    linkPeakHalfLifeMs,
    linkScore,
    linkThreshold,
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

/** What a trend's peak was, so far. */
type Peak = { readonly max_score: number; readonly max_score_at: Date };

/**
 * A trend's peak and current score, if `score` now, with the peak it had before, `before`, leaves
 * it at least `decayThreshold`. A peak counts for `peakCooldownMs`, and halves every `halfLifeMs`.
 */
const trendOf = (
    score: number,
    before: Peak | undefined,
    now: Date,
    halfLifeMs: number,
    decayThreshold: number,
): (Peak & { readonly score: number }) | undefined => {
    const stale = before === undefined ||
        before.max_score_at.getTime() < now.getTime() - peakCooldownMs;
    let peak = stale ? { max_score: 0, max_score_at: now } : before;
    if (score > peak.max_score) peak = { max_score: score, max_score_at: now };

    const current = decayed(
        peak.max_score,
        now.getTime() - peak.max_score_at.getTime(),
        halfLifeMs,
    );
    return current >= decayThreshold ? { ...peak, score: current } : undefined;
};

/**
 * Scores the hashtags that accounts used today, and those already trending, and keeps those whose
 * decayed peak is still high enough.
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

        const trend = trendOf(
            score,
            existing.get(name),
            now,
            peakHalfLifeMs,
            tagDecayThreshold,
        );
        if (trend) trending.push({ name, ...trend });
    }

    await replaceTrendingTags(ctx, trending);
};

/**
 * Scores the links that accounts shared today, and those already trending, and keeps those whose
 * decayed peak is still high enough, as for hashtags, except that a link's peak halves every
 * `linkPeakHalfLifeMs`. Statuses and boosts both count.
 */
export const refreshTrendingLinks = async (ctx: Context): Promise<void> => {
    const now = ctx.clock.now();
    const today = new Date(Math.floor(now.getTime() / dayMs) * dayMs);
    const yesterday = new Date(today.getTime() - dayMs);

    const existing = new Map((await trendingLinks(ctx)).map((row) => [row.card_id, row]));
    const ids = [
        ...new Set([...await cardsSharedBy(ctx, today, linkThreshold), ...existing.keys()]),
    ];

    const uses = new Map(
        (await linkUses(ctx, ids, [today, yesterday]))
            .map((used) => [`${used.card_id} ${used.day}`, used.accounts]),
    );

    const trending: TrendingLink[] = [];
    for (const id of ids) {
        const score = linkScore(uses.get(`${id} 0`) ?? 0, uses.get(`${id} 1`) ?? 0);
        const trend = trendOf(
            score,
            existing.get(id),
            now,
            linkPeakHalfLifeMs,
            linkDecayThreshold,
        );
        if (trend) trending.push({ card_id: id, ...trend });
    }

    await replaceTrendingLinks(ctx, trending);
};

/**
 * How far back a status can be posted and still trend, as its score halves every
 * `statusHalfLifeMs` in `scoring.ts`.
 */
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
    await refreshTrendingLinks(ctx);
    await refreshTrendingStatuses(ctx);
};
