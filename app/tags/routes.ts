import { FeaturedTag, Tag } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { isHashtagName } from "../kernel/markup.ts";
import { renderHashtags } from "../search/hashtags.ts";
import { deleteFeaturedTag, featuredTagsOf } from "./featured_tag_queries.ts";
import { featureTag, suggestedTags } from "./featured_tags.ts";
import { renderFeaturedTags } from "./render.ts";
import { tagFollowPage } from "./tag_follow_queries.ts";
import { followTag, unfollowTag } from "./tag_follows.ts";
import { displayNamesOf } from "./tag_queries.ts";

const HashtagName = z.object({
    name: z.string().meta({ description: "The name of the hashtag." }),
});

/**
 * The hashtag `name` as `viewerId` sees it, known yet or not, as Mastodon shows it. A name that
 * isn't a hashtag's is not found.
 */
const shownHashtag = async (ctx: Context, name: string, viewerId: string | null): Promise<Tag> => {
    if (!isHashtagName(name)) throw new NotFound();

    const [tag] = await renderHashtags(ctx, [name.toLowerCase()], viewerId);
    const known = (await displayNamesOf(ctx, [tag.id])).has(tag.id);
    // One no status has used, nor anyone followed or featured, is shown as it was asked for.
    return known ? tag : { ...tag, name };
};

export const tagRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/featured_tags",
        summary: "View your featured tags",
        description: "List all hashtags featured on your profile.",
        docs: "https://docs.joinmastodon.org/methods/featured_tags/#get",
        tags: ["featured_tags"],
        auth: { require: "user", scope: "read:accounts", permission: "owner:account" },
        responses: { 200: z.array(FeaturedTag) },
        handler: async (ctx, { viewer }) => {
            const featured = await renderFeaturedTags(
                ctx,
                await featuredTagsOf(ctx, viewer.accountId),
            );

            // The most used first, as on Mastodon.
            const count = (tag: FeaturedTag) => Number(tag.statuses_count);
            return { status: 200, body: featured.toSorted((a, b) => count(b) - count(a)) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/featured_tags",
        summary: "Feature a tag",
        description: "Promote a hashtag on your profile.",
        docs: "https://docs.joinmastodon.org/methods/featured_tags/#feature",
        tags: ["featured_tags"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        body: z.object({
            name: z.string().meta({
                description: "The hashtag to be featured, without the hash sign.",
            }),
        }),
        responses: { 200: FeaturedTag },
        handler: async (ctx, { body, viewer }) => {
            const result = await featureTag(ctx, viewer.accountId, body.name);
            if (result === "invalid") throw new Unprocessable("Name is invalid");
            if (result === "full") {
                throw new Unprocessable("You have already featured the maximum number of hashtags");
            }

            const [featured] = await renderFeaturedTags(ctx, [result]);
            return { status: 200, body: featured };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/featured_tags/:id",
        summary: "Unfeature a tag",
        description: "Stop promoting a hashtag on your profile.",
        docs: "https://docs.joinmastodon.org/methods/featured_tags/#unfeature",
        tags: ["featured_tags"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await deleteFeaturedTag(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/featured_tags/suggestions",
        summary: "View suggested tags to feature",
        description: "Shows up to 10 recently-used tags.",
        docs: "https://docs.joinmastodon.org/methods/featured_tags/#suggestions",
        tags: ["featured_tags"],
        auth: { require: "user", scope: "read:accounts", permission: "owner:account" },
        responses: { 200: z.array(Tag) },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: await suggestedTags(ctx, viewer.accountId),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id/featured_tags",
        summary: "Get account's featured tags",
        description: "Tags featured by this account.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#featured_tags",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.array(FeaturedTag) },
        handler: async (ctx, { params }) => {
            if (await findAccount(ctx, params.id) === undefined) throw new NotFound();

            return {
                status: 200,
                body: await renderFeaturedTags(ctx, await featuredTagsOf(ctx, params.id)),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/tags/:name",
        summary: "View information about a single tag",
        description: "Show a hashtag and its associated information",
        docs: "https://docs.joinmastodon.org/methods/tags/#get",
        tags: ["tags"],
        auth: { require: "optional" },
        params: HashtagName,
        responses: { 200: Tag },
        handler: async (ctx, { params, viewer }) => ({
            status: 200,
            body: await shownHashtag(ctx, params.name, viewer?.accountId ?? null),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/tags/:name/follow",
        summary: "Follow a hashtag",
        description:
            "Follow a hashtag. Posts containing a followed hashtag will be inserted into your home timeline.",
        docs: "https://docs.joinmastodon.org/methods/tags/#follow",
        tags: ["tags"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: HashtagName,
        responses: { 200: Tag },
        handler: async (ctx, { params, viewer }) => {
            if (!isHashtagName(params.name)) throw new NotFound();
            await followTag(ctx, viewer.accountId, params.name);

            return { status: 200, body: await shownHashtag(ctx, params.name, viewer.accountId) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/tags/:name/unfollow",
        summary: "Unfollow a hashtag",
        description:
            "Unfollow a hashtag. Posts containing this hashtag will no longer be inserted into your home timeline.",
        docs: "https://docs.joinmastodon.org/methods/tags/#unfollow",
        tags: ["tags"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: HashtagName,
        responses: { 200: Tag },
        handler: async (ctx, { params, viewer }) => {
            if (!isHashtagName(params.name)) throw new NotFound();
            await unfollowTag(ctx, viewer.accountId, params.name);

            return { status: 200, body: await shownHashtag(ctx, params.name, viewer.accountId) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/followed_tags",
        summary: "View all followed tags",
        description: "List your followed hashtags.",
        docs: "https://docs.joinmastodon.org/methods/followed_tags/#get",
        tags: ["followed_tags"],
        auth: { require: "user", scope: "read:follows", permission: "owner:follow" },
        query: PageQuery({ default: 100, max: 200 }),
        responses: { 200: Paged(Tag) },
        handler: async (ctx, { query, viewer }) => {
            const follows = await tagFollowPage(ctx, viewer.accountId, query);
            return {
                status: 200,
                body: await renderHashtags(
                    ctx,
                    follows.map((row) => row.tag),
                    viewer.accountId,
                ),
                cursors: cursorsOf(follows, query, (row) => row.id),
            };
        },
    }),
];
