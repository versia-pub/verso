import { FeaturedTag, Tag } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { deleteFeaturedTag, featuredTagsOf } from "./featured_tag_queries.ts";
import { featureTag, suggestedTags } from "./featured_tags.ts";
import { renderFeaturedTags } from "./render.ts";

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
];
