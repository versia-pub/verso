/**
 * Featured hashtags: the hashtags local users feature on their profiles, as Mastodon has them.
 * Versia has no featured hashtags, so they aren't federated, and remote accounts have none.
 * @see https://docs.joinmastodon.org/methods/featured_tags/
 * @module
 */
import type { Tag } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { isHashtagName } from "../kernel/markup.ts";
import { renderHashtags } from "../search/hashtags.ts";
import {
    type FeaturedTagRow,
    featuredTagsOf,
    insertFeaturedTag,
    recentlyUsedTags,
} from "./featured_tag_queries.ts";
import { insertTags } from "./tag_queries.ts";

/** How many hashtags a user may feature, as on Mastodon. */
export const featuredTagLimit = 10;

/** How many of a user's latest statuses suggestions come from, as on Mastodon. */
const suggestedFrom = 1000;

/** The result of featuring a hashtag. */
export type FeatureResult =
    /** The hashtag, featured now or already. */
    | FeaturedTagRow
    /** The name isn't a hashtag's. */
    | "invalid"
    /** The user already features as many hashtags as they may. */
    | "full";

/**
 * Has `accountId` feature the hashtag `name`, with or without its `#`. One the user already
 * features, in any case, is returned as it is.
 */
export const featureTag = (
    ctx: Context,
    accountId: string,
    name: string,
): Promise<FeatureResult> =>
    ctx.transaction(async (tx) => {
        const tag = name.trim().replace(/^#/, "");
        if (!isHashtagName(tag)) return "invalid";

        const featured = await featuredTagsOf(tx, accountId);
        const existing = featured.find((row) => row.tag === tag.toLowerCase());
        if (existing !== undefined) return existing;
        if (featured.length >= featuredTagLimit) return "full";

        // Mastodon lets users feature hashtags no status has used yet.
        await insertTags(tx, [tag]);
        return await insertFeaturedTag(tx, accountId, tag);
    });

/** Up to 10 hashtags that `accountId` used lately and doesn't feature, the most used first. */
export const suggestedTags = async (ctx: Context, accountId: string): Promise<Tag[]> =>
    await renderHashtags(
        ctx,
        await recentlyUsedTags(ctx, accountId, suggestedFrom, featuredTagLimit),
        accountId,
    );
