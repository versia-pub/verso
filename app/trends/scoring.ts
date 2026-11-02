/**
 * How much hashtags and statuses are trending, with Mastodon's formulas and defaults.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/trends/tags.rb
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/trends/statuses.rb
 * @module
 */

const hourMs = 60 * 60 * 1000;
export const dayMs = 24 * hourMs;

/** How many accounts must use a hashtag in a day for it to trend. */
export const tagThreshold = 5;

/** A hashtag stays trending while its decayed peak is at least this. */
export const tagDecayThreshold = 1;

/** How long a hashtag's peak counts, and how long it takes to halve. */
export const peakCooldownMs = 2 * dayMs;
export const peakHalfLifeMs = 4 * hourMs;

/** How many times a status must be liked and boosted to trend. */
export const statusThreshold = 5;

/** A status stays trending while its decayed score is at least this. */
export const statusDecayThreshold = 0.3;

/** A status's score halves this often, from when it was posted. */
export const statusHalfLifeMs = hourMs;

/**
 * How much a hashtag trends: how far the accounts that used it today, `observed`, exceed those
 * that did yesterday, `expected`, squared, or nothing if fewer did than yesterday or than the
 * threshold.
 */
export const tagScore = (observed: number, expected: number): number => {
    const baseline = expected === 0 ? 1 : expected;
    if (baseline > observed || observed < tagThreshold) return 0;

    return (observed - baseline) ** 2 / baseline;
};

/** `score` after `elapsedMs` of decay, which halves it every `halfLifeMs`. */
export const decayed = (score: number, elapsedMs: number, halfLifeMs: number): number =>
    score * 0.5 ** (elapsedMs / halfLifeMs);

/**
 * How much a status trends, decayed by how long ago it was posted: its likes and boosts, less one,
 * squared, if there are enough. A status dated after `now` has not aged.
 */
export const statusScore = (interactions: number, postedAt: Date, now: Date): number => {
    if (interactions < statusThreshold) return 0;

    const age = Math.max(0, now.getTime() - postedAt.getTime());
    return decayed((interactions - 1) ** 2, age, statusHalfLifeMs);
};
