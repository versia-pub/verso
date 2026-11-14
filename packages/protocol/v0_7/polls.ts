import { z } from "zod";
import { Entity, Integer, optional, ReferenceText, Rfc3339, RichText } from "./common.ts";

/** The key of {@link Polls} in a Note's `extensions`. */
export const pollsKey = "pub.versia:polls";

/**
 * A Note's poll, in its `extensions` under {@link pollsKey}. Its question is the Note's content.
 * `voters` counts users, which differs from the sum of `votes` when `multiple_choice` is true.
 * @see https://versia.pub/extensions/polls
 */
export const Polls = z.object({
    options: z.array(z.object({ content: RichText, votes: Integer })),
    multiple_choice: z.boolean(),
    voters: optional(Integer),
    /** When it ends, or never if it is left out. */
    expires_at: optional(Rfc3339),
});
export type Polls = z.infer<typeof Polls>;

/**
 * A user's ballot in the poll on the Note `target`: the indexes of every option they chose, at
 * least one and none twice.
 * @see https://versia.pub/extensions/polls#vote
 */
export const Vote = Entity.extend({
    type: z.literal("pub.versia:polls/Vote"),
    author: ReferenceText,
    target: ReferenceText,
    options: z.array(Integer).min(1).refine(
        (options) => new Set(options).size === options.length,
        "An option can't be chosen twice",
    ),
});
export type Vote = z.infer<typeof Vote>;
