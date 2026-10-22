import { Account, Status } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { everyone } from "../notes/audience.ts";
import { findNotes, sharePage } from "../notes/note_queries.ts";
import { canSee, visibleOriginal } from "../notes/notes.ts";
import { renderStatuses } from "../notes/render.ts";
import { likePage } from "./like_queries.ts";
import { like, unlike } from "./likes.ts";
import { share, unshare } from "./shares.ts";

/** Likes a status, or undoes it, as Mastodon's favourites. */
const likeRoute = (action: "favourite" | "unfavourite") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/statuses/:id/${action}`,
        summary: action === "favourite"
            ? "Likes a status the viewer may see"
            : "Undoes the viewer's like of a status",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:favourites", permission: "owner:like" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = action === "favourite"
                ? await like(ctx, viewer.accountId, params.id)
                : await unlike(ctx, viewer.accountId, params.id);
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    });

/**
 * Who a share is for. Without it, the sharer's default.
 * @see https://docs.joinmastodon.org/methods/statuses/#boost
 */
const ShareOptions = z.object({
    visibility: z.enum(["public", "unlisted", "private"]).optional(),
});

/** Likes of statuses, which Mastodon calls favourites, and shares, which it calls reblogs. */
export const interactionRoutes: readonly Route[] = [
    likeRoute("favourite"),
    likeRoute("unfavourite"),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/favourited_by",
        summary: "The accounts that like a status the viewer may see, newest first",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note_likes" },
        params: z.object({ id: z.string() }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer?.accountId ?? null);
            if (note === undefined) throw new NotFound();

            const likes = await likePage(ctx, { noteId: note.id }, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, likes.map((row) => row.account_id)),
                cursors: cursorsOf(likes, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/favourites",
        summary: "The statuses the viewer likes and may still see, the latest liked first",
        tags: ["favourites"],
        auth: { require: "user", scope: "read:favourites", permission: "read:note" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const likes = await likePage(ctx, { accountId: viewer.accountId }, query);
            const notes = new Map(
                (await findNotes(ctx, likes.map((row) => row.note_id))).map((
                    note,
                ) => [note.id, note]),
            );

            // A note liked may since have become one the viewer can't see, such as when they stop
            // following its author. The page is still as long, so its cursors go by the likes.
            const seen = [];
            for (const row of likes) {
                const note = notes.get(row.note_id);
                if (note && await canSee(ctx, note, viewer.accountId)) seen.push(note);
            }

            return {
                status: 200,
                body: await renderStatuses(ctx, seen, viewer.accountId),
                cursors: cursorsOf(likes, query, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses/:id/reblog",
        summary: "Shares a public or unlisted status the viewer may see, and gives the share",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:boost" },
        params: z.object({ id: z.string() }),
        body: ShareOptions,
        responses: { 200: Status },
        handler: async (ctx, { params, body, viewer }) => {
            const result = await share(ctx, viewer.accountId, params.id, body.visibility);
            if (result === "missing") throw new NotFound();
            if (result === "unshareable") {
                throw new NotPermitted("Only public and unlisted statuses can be shared");
            }

            const [status] = await renderStatuses(ctx, [result], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses/:id/unreblog",
        summary: "Undoes the viewer's share of a status, and gives the status",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:boost" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await unshare(ctx, viewer.accountId, params.id);
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/reblogged_by",
        summary: "The accounts that share a status the viewer may see, publicly, newest first",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note_boosts" },
        params: z.object({ id: z.string() }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer?.accountId ?? null);
            if (note === undefined) throw new NotFound();

            // Only the shares anyone may see, so a share for followers doesn't give its sharer away.
            const shares = await sharePage(ctx, note.id, everyone, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, shares.map((row) => row.account_id)),
                cursors: cursorsOf(shares, query, (row) => row.id),
            };
        },
    }),
];
