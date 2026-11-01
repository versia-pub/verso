import { z } from "zod";
import { contentFormatOf, optional, Rfc3339, Unsigned } from "./common.ts";

/** The key of {@link Polls} in a Note's `extensions`. */
export const pollsKey = "pub.versia:polls";

/**
 * A Note's poll, in its `extensions` under {@link pollsKey}: its options, and how many votes each
 * has, in the same order. Its question is the Note's content.
 * @see https://versia.pub/extensions/polls
 */
export const Polls = z.object({
    options: z.array(contentFormatOf("text/")),
    votes: z.array(Unsigned),
    multiple_choice: z.boolean(),
    /** When it ends, or never if it is left out. */
    expires_at: optional(Rfc3339),
});
export type Polls = z.infer<typeof Polls>;
