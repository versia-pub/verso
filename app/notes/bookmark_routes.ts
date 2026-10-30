import { Status } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { bookmarkPage } from "./bookmark_queries.ts";
import { bookmark, unbookmark } from "./bookmarks.ts";
import { findNotes } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { seenAmong } from "./visibility.ts";

/** Bookmarks a status, or undoes it. */
const bookmarkRoute = (action: "bookmark" | "unbookmark") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/statuses/:id/${action}`,
        ...action === "bookmark"
            ? {
                summary: "Bookmark a status",
                description: "Privately bookmark a status.",
                docs: "https://docs.joinmastodon.org/methods/statuses/#bookmark",
            }
            : {
                summary: "Undo bookmark of a status",
                description: "Remove a status from your private bookmarks.",
                docs: "https://docs.joinmastodon.org/methods/statuses/#unbookmark",
            },
        tags: ["statuses"],
        auth: { require: "user", scope: "write:bookmarks", permission: "owner:bookmark" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = action === "bookmark"
                ? await bookmark(ctx, viewer.accountId, params.id)
                : await unbookmark(ctx, viewer.accountId, params.id);
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    });

export const bookmarkRoutes: readonly Route[] = [
    bookmarkRoute("bookmark"),
    bookmarkRoute("unbookmark"),
    defineRoute({
        method: "GET",
        path: "/api/v1/bookmarks",
        summary: "View bookmarked statuses",
        description: "Statuses the user has bookmarked.",
        docs: "https://docs.joinmastodon.org/methods/bookmarks/#get",
        tags: ["bookmarks"],
        auth: { require: "user", scope: "read:bookmarks", permission: "owner:bookmark" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { query, viewer }) => {
            const bookmarks = await bookmarkPage(ctx, viewer.accountId, query);
            const ids = bookmarks.map((row) => row.note_id);
            const notes = new Map((await findNotes(ctx, ids)).map((note) => [note.id, note]));

            // A bookmarked status may since have become one the viewer can't see. The page is still
            // as long, so its cursors go by the bookmarks.
            const visible = await seenAmong(ctx, [...notes.keys()], viewer.accountId);
            const seen = bookmarks.flatMap((row) => {
                const note = notes.get(row.note_id);
                return note && visible.has(note.id) ? [note] : [];
            });

            return {
                status: 200,
                body: await renderStatuses(ctx, seen, viewer.accountId),
                cursors: cursorsOf(bookmarks, query, (row) => row.id),
            };
        },
    }),
];
