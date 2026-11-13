import { Context, ScheduledStatus, Status, StatusEdit, StatusSource } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Ids } from "../http/schemas.ts";
import type { Limits } from "../kernel/config_sections.ts";
import { deleteUploads } from "../media/uploads.ts";
import { unshare } from "../interactions/shares.ts";
import { DeleteOptions, draft, edit, paramsOf } from "./drafts.ts";
import { editNote, postNote } from "./notes.ts";
import { removeNote } from "./removal.ts";
import { visibleNote, visibleNotes, visibleOriginal } from "./visibility.ts";
import { threadOf } from "./threads.ts";
import { backfillLater } from "./backfill.ts";
import {
    asyncRefreshRoutes,
    contextRefresh,
    refreshHeader,
    runningRefresh,
} from "./async_refreshes.ts";
import { refreshTotals } from "./totals.ts";
import { renderHistory, renderStatuses } from "./render.ts";
import { accountStatusesRoute } from "./account_status_routes.ts";
import { pinRoute, unpinRoute } from "./pin_routes.ts";
import { bookmarkRoutes } from "./bookmark_routes.ts";
import { threadMuteRoutes } from "./thread_mute_routes.ts";
import { quoteRoutes } from "./quote_routes.ts";
import { renderScheduled } from "../schedules/render.ts";
import { scheduleNote } from "../schedules/schedules.ts";

/**
 * Statuses: posting, viewing, editing and deleting them, with posted content limited by `limits`,
 * and the threads and accounts they belong to.
 */
export const noteRoutes = (limits: Limits): readonly Route[] => [
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses",
        summary: "Post a new status",
        description: "Publish a status with the given parameters.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#create",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        body: draft(limits),
        responses: { 200: z.union([Status, ScheduledStatus]) },
        handler: async (ctx, { body, viewer }) => {
            // A time already past means now.
            const scheduledAt = body.scheduled_at;
            if (scheduledAt !== undefined && scheduledAt > ctx.clock.now()) {
                const row = await scheduleNote(ctx, viewer.accountId, scheduledAt, paramsOf(body));
                if (row === undefined) throw new NotFound("The status replied to doesn't exist");

                return { status: 200, body: (await renderScheduled(ctx, [row]))[0] };
            }

            const note = await postNote(ctx, viewer.accountId, {
                text: body.status,
                format: body.content_type,
                spoilerText: body.spoiler_text,
                visibility: body.visibility,
                sensitive: body.sensitive,
                language: body.language || undefined,
                inReplyToId: body.in_reply_to_id ?? undefined,
                quotedStatusId: body.quoted_status_id || undefined,
                mediaIds: body.media_ids,
                poll: body.poll ?? undefined,
            });
            // Mastodon gives the same answer when the status replied to exists but can't be seen.
            if (note === undefined) throw new NotFound("The status replied to doesn't exist");

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses",
        summary: "View multiple statuses",
        description: "Obtain information about multiple statuses.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#index",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        query: z.object({
            id: Ids(20).default([]).meta({
                description: "The IDs of the Statuses in the database.",
            }),
        }),
        responses: { 200: z.array(Status) },
        handler: async (ctx, { query, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const notes = await visibleNotes(ctx, query.id, viewerId);

            return { status: 200, body: await renderStatuses(ctx, notes, viewerId) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id",
        summary: "View a single status",
        description: "Obtain information about a status.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#get",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const note = await visibleNote(ctx, params.id, viewerId);
            if (note === undefined) throw new NotFound();
            if (viewerId !== null) await refreshTotals(ctx, note.id);

            const [status] = await renderStatuses(ctx, [note], viewerId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/statuses/:id",
        summary: "Edit a status",
        description:
            "Edit a given status to change its text, sensitivity, media attachments, or poll.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#edit",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        body: edit(limits),
        responses: { 200: Status },
        handler: async (ctx, { params, body, viewer }) => {
            const note = await editNote(ctx, viewer.accountId, params.id, {
                text: body.status,
                format: body.content_type,
                spoilerText: body.spoiler_text,
                sensitive: body.sensitive,
                language: body.language || undefined,
                mediaIds: body.media_ids,
                mediaChanges: body.media_attributes,
                poll: body.poll,
            });
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/context",
        summary: "Get parent and child statuses in context",
        description: "View statuses above and below this status in the thread.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#context",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Context },
        handler: async (ctx, { params, viewer }) => {
            const viewerId = viewer?.accountId ?? null;
            const note = await visibleOriginal(ctx, params.id, viewerId);
            if (note === undefined) throw new NotFound();

            let refresh = await runningRefresh(ctx, contextRefresh(note.id));
            if (viewerId !== null) {
                await refreshTotals(ctx, note.id);
                refresh ??= await backfillLater(ctx, note);
            }

            const thread = await threadOf(ctx, note, viewerId);

            return {
                status: 200,
                headers: refresh === undefined ? {} : refreshHeader(refresh),
                body: {
                    ancestors: await renderStatuses(ctx, thread.ancestors, viewerId),
                    descendants: await renderStatuses(ctx, thread.descendants, viewerId),
                },
            };
        },
    }),
    ...asyncRefreshRoutes,
    accountStatusesRoute,
    pinRoute,
    unpinRoute,
    ...bookmarkRoutes,
    ...threadMuteRoutes,
    ...quoteRoutes,
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/history",
        summary: "View edit history of a status",
        description:
            "Get all known versions of a status, including the initial and current states.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#history",
        tags: ["statuses"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.array(StatusEdit) },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer?.accountId ?? null);
            if (note === undefined) throw new NotFound();

            return { status: 200, body: await renderHistory(ctx, note) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/source",
        summary: "View status source",
        description: "Obtain the source properties for a status so that it can be edited.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#source",
        tags: ["statuses"],
        auth: { require: "user", scope: "read:statuses", permission: "read:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: StatusSource },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleOriginal(ctx, params.id, viewer.accountId);
            if (note === undefined) throw new NotFound();

            return {
                status: 200,
                body: {
                    id: note.id,
                    text: note.content,
                    spoiler_text: note.spoiler_text,
                    content_type: note.content_format,
                },
            };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/statuses/:id",
        summary: "Delete a status",
        description: "Delete one of your own statuses.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#delete",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        // Mastodon reads it from the query or the form alike.
        query: DeleteOptions,
        body: DeleteOptions,
        responses: { 200: Status },
        handler: async (ctx, { params, query, body, viewer }) => {
            const note = await visibleNote(ctx, params.id, viewer.accountId);
            if (note?.account_id !== viewer.accountId) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId, { source: true });

            // A boost is undone, as unboosting does, rather than deleted as a status.
            const removed = note.reblog_of_id === null
                ? await removeNote(ctx, note.id)
                : await unshare(ctx, viewer.accountId, note.reblog_of_id) !== undefined;
            if (!removed) throw new NotFound();

            // Otherwise the media stays for a while, so the status can be redrafted.
            if (note.reblog_of_id === null && (query.delete_media ?? body.delete_media)) {
                await deleteUploads(
                    ctx,
                    viewer.accountId,
                    status.media_attachments.map((m) => m.id),
                );
            }

            return { status: 200, body: status };
        },
    }),
];
