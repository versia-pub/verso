import { z } from "zod";
import { Account } from "./account.ts";

/**
 * Why an account is suggested.
 * @see https://docs.joinmastodon.org/entities/Suggestion/#sources
 */
export const SuggestionSource = z.enum([
    "featured",
    "most_followed",
    "most_interactions",
    "similar_to_recently_followed",
    "friends_of_friends",
]);
export type SuggestionSource = z.infer<typeof SuggestionSource>;

/**
 * An account that is suggested to the viewer to follow.
 * @see https://docs.joinmastodon.org/entities/Suggestion/
 */
export const Suggestion = z.object({
    /** The first of `sources`, as older apps know it, or `null` if they don't know any of them. */
    source: z.enum(["staff", "past_interactions", "global"]).nullable(),
    /** Why it is suggested. */
    sources: z.array(SuggestionSource),
    account: Account,
});
export type Suggestion = z.infer<typeof Suggestion>;
