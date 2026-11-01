import { Announcement } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { publishedAnnouncements } from "./announcement_queries.ts";
import { dismissAnnouncement } from "./announcements.ts";
import { renderAnnouncements } from "./render.ts";

const AnnouncementId = z.object({
    id: z.string().meta({ description: "The ID of the Announcement in the database." }),
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
        // As on Mastodon, any token for a user, whatever its scopes.
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
];
