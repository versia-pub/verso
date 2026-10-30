import type { FeaturedTag } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { type FeaturedTagRow, taggedStats } from "./featured_tag_queries.ts";

/**
 * Featured hashtags, with how many of their account's statuses that anyone may see have them, and
 * when the latest was posted, as Mastodon counts them. Verso has no pages of an account's statuses,
 * so each links to the hashtag's.
 */
export const renderFeaturedTags = async (
    ctx: Context,
    rows: readonly FeaturedTagRow[],
): Promise<FeaturedTag[]> => {
    const rendered = [];
    for (const row of rows) {
        const stats = await taggedStats(ctx, row.account_id, row.tag);
        rendered.push({
            id: row.id,
            name: row.name,
            url: ctx.urls.url`/tags/${row.tag}`,
            statuses_count: String(stats.count),
            last_status_at: stats.latest?.toISOString().slice(0, 10) ?? null,
        });
    }

    return rendered;
};
