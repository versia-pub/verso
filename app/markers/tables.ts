/** The timelines a user can mark their place in, as on Mastodon. */
export const timelines = ["home", "notifications"] as const;
export type Timeline = typeof timelines[number];

/** Whether `name` is a timeline a user can mark their place in. */
export const isTimeline = (name: string): name is Timeline =>
    (timelines as readonly string[]).includes(name);

/**
 * Where a local user last read up to in a timeline, so that their apps can carry on from there, as
 * Mastodon's markers.
 * @see https://docs.joinmastodon.org/entities/Marker/
 */
export type MarkersTable = {
    account_id: string;
    timeline: Timeline;
    /** The newest status, or notification, read. */
    last_read_id: string;
    /** How many times it was set. */
    version: number;
    updated_at: Date;
};
