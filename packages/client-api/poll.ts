import { z } from "zod";
import { CustomEmoji } from "./custom_emoji.ts";

/**
 * A poll attached to a status.
 * @see https://docs.joinmastodon.org/entities/Poll/
 */
export const Poll = z.object({
    id: z.string(),
    /** When it ends, or `null` if it never does. */
    expires_at: z.iso.datetime().nullable(),
    expired: z.boolean(),
    /** Whether a voter may choose more than one option. */
    multiple: z.boolean(),
    votes_count: z.int().min(0),
    /** How many accounts voted, or `null` if unknown. */
    voters_count: z.int().min(0).nullable(),
    options: z.array(z.object({
        title: z.string(),
        /** `null` while the poll hides its totals. */
        votes_count: z.int().min(0).nullable(),
    })),
    /** The custom emojis used in the options. */
    emojis: z.array(CustomEmoji),
    /** Whether the viewer voted, or wrote it. Only for a logged-in viewer, as is `own_votes`. */
    voted: z.boolean().optional(),
    /** The options the viewer voted for, by index. */
    own_votes: z.array(z.int().min(0)).optional(),
});
export type Poll = z.infer<typeof Poll>;
