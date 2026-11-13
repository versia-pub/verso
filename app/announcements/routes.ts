import { Announcement } from "@versia/client-api";
import { z } from "zod";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { publishedAnnouncements } from "./announcement_queries.ts";
import { dismissAnnouncement } from "./announcements.ts";
import { reactToAnnouncement, unreactToAnnouncement } from "./reactions.ts";
import { renderAnnouncements } from "./render.ts";

const AnnouncementId = z.object({
    id: z.string().meta({ description: "The ID of the Announcement in the database." }),
});

const ReactionParams = AnnouncementId.extend({
    name: z.string().meta({
        description: "Unicode emoji, or the shortcode of an existing custom emoji, without colons.",
    }),
});

const docs = "https://docs.joinmastodon.org/methods/announcements";

export const announcementRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/announcements",
        summary: "View all announcements",
        description: "See all currently active announcements set by admins.",
        docs: `${docs}/#get`,
        tags: ["announcements"],
        // Mastodon accepts any token for a user here, whatever its scopes.
        auth: { require: "user" },
        responses: { 200: z.array(Announcement) },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: await renderAnnouncements(
                ctx,
                await publishedAnnouncements(ctx),
                viewer.accountId,
            ),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/announcements/:id/dismiss",
        summary: "Dismiss an announcement",
        description: "Allows a user to mark the announcement as read.",
        docs: `${docs}/#dismiss`,
        tags: ["announcements"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
        params: AnnouncementId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await dismissAnnouncement(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/announcements/:id/reactions/:name",
        summary: "Add a reaction to an announcement",
        description: "React to an announcement with an emoji.",
        docs: `${docs}/#put-reactions`,
        tags: ["announcements"],
        auth: { require: "user", scope: "write:favourites", permission: "owner:reaction" },
        params: ReactionParams,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            switch (await reactToAnnouncement(ctx, viewer.accountId, params.id, params.name)) {
                case "missing":
                    throw new NotFound();
                case "unknown emoji":
                    throw new Unprocessable("Name is not a recognized emoji");
                case "limit reached":
                    throw new Unprocessable("Limit of different reactions reached");
                case "duplicate":
                    throw new Unprocessable("Duplicate record");
                case "reacted":
                    return { status: 200, body: {} };
            }
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/announcements/:id/reactions/:name",
        summary: "Remove a reaction from an announcement",
        description: "Undo a react emoji to an announcement.",
        docs: `${docs}/#delete-reactions`,
        tags: ["announcements"],
        auth: { require: "user", scope: "write:favourites", permission: "owner:reaction" },
        params: ReactionParams,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await unreactToAnnouncement(ctx, viewer.accountId, params.id, params.name)) {
                throw new NotFound();
            }
            return { status: 200, body: {} };
        },
    }),
];
