import { findAccount } from "../accounts/account_queries.ts";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import { notePageBy } from "./note_queries.ts";
import { pinnedNotes } from "./pin_queries.ts";
import { renderStatuses } from "./render.ts";
import { visibilitiesFor } from "./visibility.ts";
import { Status } from "@versia/client-api";
import { z } from "zod";

/**
 * Which of an account's statuses to return. Pinned statuses are few, so all of them are returned at
 * once.
 * @see https://docs.joinmastodon.org/methods/accounts/#statuses
 */
const AccountStatusesQuery = PageQuery({ default: 20, max: 40 }).extend({
    exclude_replies: Flag.default(false),
    exclude_reblogs: Flag.default(false),
    only_media: Flag.default(false),
    pinned: Flag.default(false),
    tagged: z.string().optional(),
});

/** An account's statuses the viewer may see, newest first. */
export const accountStatusesRoute = defineRoute({
    method: "GET",
    path: "/api/v1/accounts/:id/statuses",
    summary: "An account's statuses that the viewer may see, newest first",
    tags: ["accounts"],
    auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
    params: z.object({ id: z.string() }),
    query: AccountStatusesQuery,
    responses: { 200: Paged(Status) },
    handler: async (ctx, { params, query, viewer }) => {
        const viewerId = viewer?.accountId ?? null;
        const account = await findAccount(ctx, params.id);
        if (account === undefined) throw new NotFound();

        const visibilities = await visibilitiesFor(ctx, account.id, viewerId);
        if (query.pinned) {
            const pinned = await pinnedNotes(ctx, account.id, visibilities, query.only_media);
            return {
                status: 200,
                body: await renderStatuses(ctx, pinned, viewerId),
                cursors: {},
            };
        }

        const notes = await notePageBy(
            ctx,
            account.id,
            visibilities,
            {
                excludeReplies: query.exclude_replies,
                excludeShares: query.exclude_reblogs,
                tag: query.tagged,
                onlyMedia: query.only_media,
            },
            query,
        );
        return {
            status: 200,
            body: await renderStatuses(ctx, notes, viewerId),
            cursors: cursorsOf(notes, query, (note) => note.id),
        };
    },
});
