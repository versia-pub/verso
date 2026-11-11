/** A hashtag that is trending, or is not yet approved to be shown as trending. */
export type TrendingTagsTable = {
    /** The hashtag, in `tags`. */
    name: string;
    /** How much it is trending now, after its peak decayed. */
    score: number;
    /** Its peak score, which counts for `peakCooldownMs` in `scoring.ts`. */
    max_score: number;
    /** When it had `max_score`. */
    max_score_at: Date;
};

/** A status that is trending, or is not yet approved to be shown as trending. */
export type TrendingStatusesTable = {
    note_id: string;
    /** Its author's id, of whom only the top-scoring status is kept. */
    account_id: string;
    /** How much it is trending now, after its age decayed it. */
    score: number;
};

/** A link that is trending, or is not yet approved to be shown as trending. */
export type TrendingLinksTable = {
    /** The page's preview card. */
    card_id: string;
    /** How much it is trending now, after its peak decayed. */
    score: number;
    /** Its peak score, which counts for `peakCooldownMs` in `scoring.ts`. */
    max_score: number;
    /** When it had `max_score`. */
    max_score_at: Date;
};
