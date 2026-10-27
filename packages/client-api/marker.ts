import { z } from "zod";

/**
 * Where a user last read up to in a timeline.
 * @see https://docs.joinmastodon.org/entities/Marker/
 */
export const Marker = z.object({
    /** The newest status, or notification, read. */
    last_read_id: z.string(),
    /** Goes up each time the marker is set. */
    version: z.int(),
    updated_at: z.iso.datetime(),
});
export type Marker = z.infer<typeof Marker>;

/** The markers of a user, in those of the timelines asked for that they have one in. */
export const Markers = z.object({
    home: Marker.optional(),
    notifications: Marker.optional(),
});
export type Markers = z.infer<typeof Markers>;
