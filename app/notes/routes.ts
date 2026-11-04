import { Context, ScheduledStatus, Status, StatusEdit, StatusSource } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Ids, Integer, Strings, Text } from "../http/schemas.ts";
import type { Limits } from "../kernel/config_sections.ts";
import { countText } from "../kernel/markup.ts";
import { FocusPoint, MediaDescription } from "../media/routes.ts";
import { deleteUploads } from "../media/uploads.ts";
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
import { threadMuteRoutes } from "./thread_mute_routes.ts";
import { quoteRoutes } from "./quote_routes.ts";
import { renderScheduled } from "../schedules/render.ts";
import { ScheduledAt } from "../schedules/routes.ts";
import { scheduleNote } from "../schedules/schedules.ts";
import type { ScheduledParams } from "../schedules/tables.ts";

/** What deleting a status takes. */
const DeleteOptions = z.object({
    delete_media: Flag.optional().meta({
        description: "Whether to delete the status's media at once, rather than keep it for a " +
            "redraft.",
    }),
});

/** What a status says, whether it is new or edited. */
const text = {
    sensitive: Flag.optional(),
    /** Empty or `null` for the author's default, or for an edit, the status's own. */
    language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).nullish(),
};

/**
 * A poll, limited by `limits`. Its options are trimmed, and blank ones left out, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/statuses/#form-data-parameters
 */
const PollDraft = (limits: Limits) =>
    z.object({
        options: Strings
            .transform((options) => options.map((option) => option.trim()).filter(Boolean))
            .pipe(
                z.array(Text(limits.poll_option))
                    .min(2, { error: "Must have at least 2 options" })
                    .max(limits.poll_options, {
                        error: `Must have at most ${limits.poll_options} options`,
                    })
                    .refine((options) => new Set(options).size === options.length, {
                        error: "Must not have the same option twice",
                    }),
            )
            .meta({
                description: "Possible answers to the poll. If provided, `media_ids` cannot be " +
                    "used, and `poll[expires_in]` must be provided.",
            }),
        expires_in: Integer.pipe(
            z.int()
                .min(limits.poll_min_seconds, {
                    error: `Must be at least ${limits.poll_min_seconds} seconds`,
                })
                .max(limits.poll_max_seconds, {
                    error: `Must be at most ${limits.poll_max_seconds} seconds`,
                }),
        ).meta({
            description: "Duration that the poll should be open, in seconds. If provided, " +
                "`media_ids` cannot be used, and `poll[options]` must be provided.",
        }),
        multiple: Flag.default(false).meta({
            description: "Allow multiple choices? Defaults to false.",
        }),
        hide_totals: Flag.default(false).meta({
            description: "Hide vote counts until the poll ends? Defaults to false.",
        }),
    }).transform((poll) => ({
        options: poll.options,
        expiresIn: poll.expires_in,
        multiple: poll.multiple,
        hideTotals: poll.hide_totals,
    }));

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

/** Who may quote a status, which Verso doesn't act on. */
const quotePolicy = z.enum(["public", "followers", "nobody"]).optional();

/** Text may be blank if media is attached, or a status is quoted. */
const notBlank = {
    check: (body: { status: string; media_ids?: string[]; quoted_status_id?: string | null }) =>
        body.status.trim() !== "" || (body.media_ids ?? []).length > 0 ||
        Boolean(body.quoted_status_id),
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
 * A quote policy is accepted and ignored; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
const draft = (limits: Limits) =>
    z.object({
        ...text,
        status: z.string().default(""),
        media_ids: MediaIds(limits).default([]),
        content_type: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
        spoiler_text: z.string().default(""),
        poll: PollDraft(limits).nullish(),
        visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
        in_reply_to_id: z.string().nullish(),
        quoted_status_id: z.string().nullish(),
        quote_approval_policy: quotePolicy,
        scheduled_at: ScheduledAt,
    })
        .refine(notBlank.check, notBlank.error)
        .refine(limited(limits).check, limited(limits).error);

/** What a scheduled status will be posted with, as `body` asks. */
const paramsOf = (body: z.output<ReturnType<typeof draft>>): ScheduledParams => ({
    text: body.status,
    content_type: body.content_type,
    spoiler_text: body.spoiler_text,
    sensitive: body.sensitive ?? null,
    visibility: body.visibility ?? null,
    language: body.language || null,
    in_reply_to_id: body.in_reply_to_id ?? null,
    quoted_status_id: body.quoted_status_id || null,
    media_ids: body.media_ids.length > 0 ? body.media_ids : null,
    poll: body.poll
        ? {
            options: body.poll.options,
            expires_in: body.poll.expiresIn,
            multiple: body.poll.multiple,
            hide_totals: body.poll.hideTotals,
        }
        : null,
});

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
        /** Replaces the status's poll, or with `null`, removes it. If omitted, it stays. */
        poll: PollDraft(limits).nullable().optional(),
        /** Ignored, as is `quoted_status_id`, which can't be changed. */
        quote_approval_policy: quotePolicy,
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
        responses: { 200: z.union([Status, ScheduledStatus]) },
        handler: async (ctx, { body, viewer }) => {
            // A time already past means now, as on Mastodon.
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
