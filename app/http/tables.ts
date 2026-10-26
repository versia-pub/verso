/** Request counts for rate limits, when they are stored in the database. */
export type RateLimitsTable = {
    /** Who the requests count against, such as `ip:203.0.113.9`. */
    key: string;
    count: number;
    resets_at: Date;
};
