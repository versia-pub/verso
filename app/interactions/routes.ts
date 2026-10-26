import { Account, Status, StatusReaction } from "@versia/client-api";
import { z } from "zod";
import { publicAccounts } from "../accounts/public.ts";
import { viewerBlocks } from "../graph/blocks.ts";
import { NotFound, NotPermitted, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { everyone } from "../notes/audience.ts";
import { findNotes } from "../notes/note_queries.ts";
import { sharePage } from "../notes/share_queries.ts";
import { seenAmong, visibleOriginal } from "../notes/visibility.ts";
import { renderStatuses } from "../notes/render.ts";
import { likePage } from "./like_queries.ts";
import { like, unlike } from "./likes.ts";
import { emojiOf, emojiReactionPage, reactionsOf } from "./reaction_queries.ts";
import { react, unreact } from "./reactions.ts";
import { reactionName, renderReactions } from "./render.ts";
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

/** Versia Server's reaction routes, which Verso's follow. */
const versiaServerReactions =
    "https://github.com/versia-pub/server/tree/main/packages/api/routes/api/v1/statuses/[id]/reactions";

/**
 * Reacts to a status with an emoji, or undoes it, as Versia Server does. The emoji is a Unicode
 * one, or one of this instance's by its shortcode in colons.
 * @see https://github.com/versia-pub/server/tree/main/packages/api/routes/api/v1/statuses/[id]/reactions
 */
const reactionRoute = (method: "PUT" | "DELETE") =>
    defineRoute({
        method,
        path: "/api/v1/statuses/:id/reactions/:name",
        summary: method === "PUT"
            ? "Reacts to a status the viewer may see with an emoji"
            : "Undoes the viewer's reaction to a status with an emoji",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:reaction" },
        params: z.object({ id: z.string(), name: z.string().min(1) }),
        responses: method === "PUT" ? { 201: Status } : { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const result = method === "PUT"
                ? await react(ctx, viewer.accountId, params.id, params.name)
                : await unreact(ctx, viewer.accountId, params.id, params.name);
            if (result === "missing") throw new NotFound();
            if (result === "unknown emoji") {
                throw new Unprocessable("Not a Unicode emoji, or one of this instance's");
            }

            const [status] = await renderStatuses(ctx, [result], viewer.accountId);
            return { status: method === "PUT" ? 201 : 200, body: status };
        },
    });

/**
 * Likes of statuses, which Mastodon calls favourites, shares, which it calls reblogs, and
 * reactions, as Versia Server has them.
 */
export const interactionRoutes: readonly Route[] = [
    reactionRoute("PUT"),
    reactionRoute("DELETE"),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/reactions",
        summary: "The reactions to a status the viewer may see, by emoji, with how many made each",
        description: "Who made them is listed for each emoji, a page at a time, by " +
            "`GET /api/v1/statuses/:id/reactions/:name`.",
        docs: versiaServerReactions,
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:reaction" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.array(StatusReaction) },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer?.accountId ?? null);
            if (note === undefined) throw new NotFound();

            const viewerId = viewer?.accountId ?? null;
            const groups =
                (await reactionsOf(ctx, [note.id], viewerId, viewerBlocks(ctx, viewerId)))
                    .get(note.id) ?? [];
            return { status: 200, body: renderReactions(groups, viewer !== undefined) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/reactions/:name",
        summary:
            "The accounts that reacted to a status the viewer may see with an emoji, newest first",
        description:
            "The emoji is named as the status's reactions name it: a Unicode emoji, or a " +
            "custom one's shortcode in colons, with its domain if it is another instance's, " +
            "such as `:blob@b.example:`.",
        docs: versiaServerReactions,
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:reaction" },
        params: z.object({ id: z.string(), name: z.string().min(1) }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const note = await visibleOriginal(ctx, params.id, viewerId);
            if (note === undefined) throw new NotFound();

            const blocked = viewerBlocks(ctx, viewerId);
            const group = (await reactionsOf(ctx, [note.id], viewerId, blocked)).get(note.id)
                ?.find((group) => reactionName(group) === params.name);
            if (group === undefined) throw new NotFound();

            const reactions = await emojiReactionPage(ctx, note.id, emojiOf(group), blocked, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, reactions.map((row) => row.account_id)),
                cursors: cursorsOf(reactions, query, (row) => row.id),
            };
        },
    }),
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

            const blocked = viewerBlocks(ctx, viewer?.accountId ?? null);
            const likes = await likePage(ctx, { noteId: note.id, blocked }, query);
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
            const visible = await seenAmong(ctx, [...notes.keys()], viewer.accountId);
            const seen = likes.flatMap((row) => {
                const note = notes.get(row.note_id);
                return note && visible.has(note.id) ? [note] : [];
            });

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

            // Only the shares anyone may see, so a share for followers doesn't give its sharer
            // away.
            const blocked = viewerBlocks(ctx, viewer?.accountId ?? null);
            const shares = await sharePage(ctx, note.id, everyone, blocked, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, shares.map((row) => row.account_id)),
                cursors: cursorsOf(shares, query, (row) => row.id),
            };
        },
    }),
];
