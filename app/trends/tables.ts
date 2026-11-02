/** A hashtag that is trending, or is not yet approved to be shown as trending. */
export type TrendingTagsTable = {
    /** The hashtag, in `tags`. */
    name: string;
    /** How much it is trending now, after its peak decayed. */
    score: number;
    /** The highest score it had in the last two days. */
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
