import { Status } from "@versia/client-api";
import { z } from "zod";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { viewerHidden } from "../graph/hidden.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { everyone } from "./audience.ts";
import { findNote } from "./note_queries.ts";
import { renderStatuses } from "./render.ts";
import { quotePage } from "./thread_queries.ts";
import { seenAmong, visibleOriginal } from "./visibility.ts";

export const quoteRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/quotes",
        summary: "See quotes of a status",
        description: "View quotes for a given status.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#quotes",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: z.object({ id: z.string() }),
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Status) },
        handler: async (ctx, { params, query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const note = await visibleOriginal(ctx, params.id, viewerId);
            if (note === undefined) throw new NotFound();

            // Those a viewer may see among all the quotes are found after the page is read.
            const visibilities = viewerId === null
                ? everyone
                : ["public", "unlisted", "private", "direct"] as const;
            const quotes = await quotePage(
                ctx,
                note.id,
                visibilities,
                viewerHidden(ctx, viewerId),
                query,
            );
            const visible = await seenAmong(ctx, quotes.map((quote) => quote.id), viewerId);

            // The page is as long as it was before leaving out those the viewer can't see, so the
            // cursors go by the quotes.
            return {
                status: 200,
                body: await renderStatuses(
                    ctx,
                    quotes.filter((quote) => visible.has(quote.id)),
                    viewerId,
                ),
                cursors: cursorsOf(quotes, query, (quote) => quote.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses/:id/quotes/:quote_id/revoke",
        summary: "Revoke a quote post",
        description: "Revoke quote authorization of a status quoting a status of yours.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#revoke_quote",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: z.object({ id: z.string(), quote_id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer.accountId);
            const quote = await findNote(ctx, params.quote_id);
            if (note === undefined || quote?.quote_id !== note.id) throw new NotFound();

            // Quotes are never put up for review, so there is nothing to take back.
            throw new NotPermitted("Verso doesn't support revoking quotes");
        },
    }),
];
