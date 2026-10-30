import { Context, Status, StatusEdit, StatusSource } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Ids } from "../http/schemas.ts";
import type { Limits } from "../kernel/config_sections.ts";
import { countText } from "../kernel/markup.ts";
import { FocusPoint, MediaDescription } from "../media/routes.ts";
import { unshare } from "../interactions/shares.ts";
import { editNote, postNote } from "./notes.ts";
import { removeNote } from "./removal.ts";
import { visibleNote, visibleNotes, visibleOriginal } from "./visibility.ts";
import { threadOf } from "./threads.ts";
import { refreshTotals } from "./totals.ts";
import { renderHistory, renderStatuses } from "./render.ts";
import { accountStatusesRoute } from "./account_status_routes.ts";
import { pinRoute, unpinRoute } from "./pin_routes.ts";
import { bookmarkRoutes } from "./bookmark_routes.ts";

/**
 * Features Verso can't post yet. If empty or omitted they are accepted; if given a value they are
 * rejected, rather than silently ignored without the client knowing.
 */
const NotYet = (what: string) =>
    z.unknown().refine(
        (value) =>
            value === undefined || value === null || value === "" ||
            (Array.isArray(value) && value.length === 0),
        { error: `${what} aren't supported yet` },
    ).optional();

/** What a status says, whether it is new or edited. */
const text = {
    sensitive: Flag.optional(),
    /** Empty or `null` for the author's default, or for an edit, the status's own. */
    language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).nullish(),
    poll: NotYet("Polls"),
};

/** The uploads attached to a status, in order, at most `limits.attachments` of them. */
const MediaIds = (limits: Limits) =>
    z.union([
        // As forms send one id, or a field left empty.
        z.string().transform((id) => id === "" ? [] : [id]),
        z.array(z.string()),
        z.null().transform(() => []),
    ])
        .pipe(
            z.array(z.string()).max(limits.attachments, {
                error: `At most ${limits.attachments} files can be attached`,
            }),
        );

/** A change to the description of media attached to a status. */
const MediaAttribute = (limits: Limits) =>
    z.object({
        id: z.string(),
        description: MediaDescription(limits).optional(),
        focus: FocusPoint.optional(),
    });

/** Text may be blank if media is attached. */
const notBlank = {
    check: (body: { status: string; media_ids?: string[] }) =>
        body.status.trim() !== "" || (body.media_ids ?? []).length > 0,
    error: { error: "Can't be blank without attachments", path: ["status"] },
};

/** Limits the status text and content warning together to at most `limits.status` characters. */
const limited = (limits: Limits) => ({
    check: (body: { status: string; spoiler_text?: string }) =>
        countText(body.status) + countText(body.spoiler_text ?? "") <= limits.status,
    error: { error: `Must be at most ${limits.status} characters`, path: ["status"] },
});

/**
 * What a new status may say. It is plain text, unless `content_type` says Markdown, as on Pleroma.
 * Quote policies are omitted; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
const draft = (limits: Limits) =>
    z.object({
        ...text,
        status: z.string().default(""),
        media_ids: MediaIds(limits).default([]),
        content_type: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
        spoiler_text: z.string().default(""),
        visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
        in_reply_to_id: z.string().nullish(),
        scheduled_at: NotYet("Scheduled statuses"),
    })
        .refine(notBlank.check, notBlank.error)
        .refine(limited(limits).check, limited(limits).error);

/**
 * What an edited status may say. Omitted fields stay as they were, including the text format. A
 * content warning left unchanged isn't counted toward the limit.
 * @see https://docs.joinmastodon.org/methods/statuses/#edit
 */
const edit = (limits: Limits) =>
    z.object({
        ...text,
        status: z.string(),
        /** Replaces the status's media. If omitted, the media stays as it was. */
        media_ids: MediaIds(limits).optional(),
        media_attributes: z.array(MediaAttribute(limits)).default([]),
        content_type: z.enum(["text/plain", "text/markdown"]).optional(),
        spoiler_text: z.string().optional(),
    })
        .refine(notBlank.check, notBlank.error)
        .refine(limited(limits).check, limited(limits).error);

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
        responses: { 200: Status },
        handler: async (ctx, { body, viewer }) => {
            const note = await postNote(ctx, viewer.accountId, {
                text: body.status,
                format: body.content_type,
                spoilerText: body.spoiler_text,
                visibility: body.visibility,
                sensitive: body.sensitive,
                language: body.language || undefined,
                inReplyToId: body.in_reply_to_id ?? undefined,
                mediaIds: body.media_ids,
            });
            // As Mastodon responds when the status replied to can't be seen.
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
            if (viewerId !== null) await refreshTotals(ctx, note.id);

            const thread = await threadOf(ctx, note, viewerId);
            return {
                status: 200,
                body: {
                    ancestors: await renderStatuses(ctx, thread.ancestors, viewerId),
                    descendants: await renderStatuses(ctx, thread.descendants, viewerId),
                },
            };
        },
    }),
    accountStatusesRoute,
    pinRoute,
    unpinRoute,
    ...bookmarkRoutes,
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
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleNote(ctx, params.id, viewer.accountId);
            if (note?.account_id !== viewer.accountId) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId, { source: true });
            // A boost is undone, as unboosting does, rather than deleted as a status.
            const removed = note.reblog_of_id === null
                ? await removeNote(ctx, note.id)
                : await unshare(ctx, viewer.accountId, note.reblog_of_id) !== undefined;
            if (!removed) throw new NotFound();

            return { status: 200, body: status };
        },
    }),
];
