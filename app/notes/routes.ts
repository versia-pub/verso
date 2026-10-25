import { Context, Status, StatusEdit, StatusSource } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import type { Limits } from "../kernel/config.ts";
import { countText } from "../kernel/markup.ts";
import { notePageBy } from "./note_queries.ts";
import { pinnedNotes } from "./pin_queries.ts";
import { pin, pinLimit, unpin } from "./pins.ts";
import { unshare } from "../interactions/shares.ts";
import {
    editNote,
    postNote,
    removeNote,
    visibilitiesFor,
    visibleNote,
    visibleOriginal,
} from "./notes.ts";
import { threadOf } from "./threads.ts";
import { refreshTotals } from "./totals.ts";
import { renderHistory, renderStatuses } from "./render.ts";

/**
 * What Verso can't post yet. Given empty, or not at all, it is taken; given with anything in it, it
 * is refused, rather than left out without the client knowing.
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
    status: z.string().refine((text) => text.trim() !== "", { error: "Can't be blank" }),
    sensitive: Flag.optional(),
    /** Empty or `null` for the author's default, or for an edit, the status's own. */
    language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).nullish(),
    media_ids: NotYet("Attachments"),
    poll: NotYet("Polls"),
};

/** The uploads attached to a status, in order, at most `limits.attachments` of them. */
const MediaIds = (limits: Limits) =>
    z.union([
        // As forms send one, or a field left empty.
        z.string().transform((id) => id === "" ? [] : [id]),
        z.array(z.string()),
        z.null().transform(() => []),
    ])
        .pipe(
            z.array(z.string()).max(limits.attachments, {
                error: `At most ${limits.attachments} files can be attached`,
            }),
        )
        .default([]);

/** Holds a status and its content warning to at most `limits.status` long together. */
const limited = (limits: Limits) => ({
    check: (body: { status: string; spoiler_text?: string }) =>
        countText(body.status) + countText(body.spoiler_text ?? "") <= limits.status,
    error: { error: `Must be at most ${limits.status} characters`, path: ["status"] },
});

/**
 * What a new status may say. It is written in plain text, unless `content_type` says Markdown, as
 * on Pleroma. Quote policies are left out; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
const draft = (limits: Limits) =>
    z.object({
        ...text,
        // Blank, if files are attached.
        status: z.string().default(""),
        media_ids: MediaIds(limits),
        content_type: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
        spoiler_text: z.string().default(""),
        visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
        in_reply_to_id: z.string().nullish(),
        scheduled_at: NotYet("Scheduled statuses"),
    })
        .refine((body) => body.status.trim() !== "" || body.media_ids.length > 0, {
            error: "Can't be blank without attachments",
            path: ["status"],
        })
        .refine(limited(limits).check, limited(limits).error);

/**
 * What an edited status may say. What is left out stays as it was, including how it is written. A
 * content warning kept as it was isn't counted toward the limit.
 * @see https://docs.joinmastodon.org/methods/statuses/#edit
 */
const edit = (limits: Limits) =>
    z.object({
        ...text,
        content_type: z.enum(["text/plain", "text/markdown"]).optional(),
        spoiler_text: z.string().optional(),
    }).refine(limited(limits).check, limited(limits).error);

/**
 * Which of an account's statuses to give. Verso has no media yet, so asking only for statuses with
 * media gives none. Pinned ones, of which there are few, are given all at once.
 * @see https://docs.joinmastodon.org/methods/accounts/#statuses
 */
const AccountStatusesQuery = PageQuery({ default: 20, max: 40 }).extend({
    exclude_replies: Flag.default(false),
    exclude_reblogs: Flag.default(false),
    only_media: Flag.default(false),
    pinned: Flag.default(false),
    tagged: z.string().optional(),
});

/**
 * Statuses: posting, viewing, editing and deleting them, with what is posted held to `limits`, and
 * the threads and accounts they are in.
 */
export const noteRoutes = (limits: Limits): readonly Route[] => [
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses",
        summary: "Posts a status",
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
            // As Mastodon answers when the status replied to can't be seen.
            if (note === undefined) throw new NotFound("The status replied to doesn't exist");

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id",
        summary: "A status, if the viewer may see it",
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
        summary: "Edits one of the viewer's statuses",
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
            });
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/context",
        summary:
            "The statuses a status replies to, and the replies under it, that the viewer may see",
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
    defineRoute({
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
            if (query.only_media) return { status: 200, body: [], cursors: {} };

            const visibilities = await visibilitiesFor(ctx, account.id, viewerId);
            if (query.pinned) {
                const pinned = await pinnedNotes(ctx, account.id, visibilities);
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
                },
                query,
            );
            return {
                status: 200,
                body: await renderStatuses(ctx, notes, viewerId),
                cursors: cursorsOf(notes, query, (note) => note.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses/:id/pin",
        summary: "Pin status to profile",
        description: "Feature one of your own public statuses at the top of your profile.\n\n" +
            `Like Mastodon, Verso lets an account pin its public, unlisted and private statuses, ` +
            `up to ${pinLimit} of them.`,
        docs: "https://docs.joinmastodon.org/methods/statuses/#pin",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const result = await pin(ctx, viewer.accountId, params.id);
            if (result === "missing") throw new NotFound();
            if (result === "unpinnable") {
                throw new Unprocessable("Only one's own statuses, not reblogs nor direct ones");
            }
            if (result === "full") {
                throw new Unprocessable(`At most ${pinLimit} statuses can be pinned`);
            }

            const [status] = await renderStatuses(ctx, [result], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/statuses/:id/unpin",
        summary: "Unpin status from profile",
        description: "Unfeature a status from the top of your profile.",
        docs: "https://docs.joinmastodon.org/methods/statuses/#unpin",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:accounts", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await unpin(ctx, viewer.accountId, params.id);
            if (note === undefined) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/statuses/:id/history",
        summary: "What a status said before each edit, and now, if the viewer may see it",
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
        summary: "A status as its author wrote it, if the viewer may see it, for editing it",
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
        summary: "Deletes one of the viewer's statuses or shares, and gives it back, to redraft",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleNote(ctx, params.id, viewer.accountId);
            if (note?.account_id !== viewer.accountId) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId, { source: true });
            // A share is undone, as unsharing does, rather than deleted as a note.
            const removed = note.reblog_of_id === null
                ? await removeNote(ctx, note.id)
                : await unshare(ctx, viewer.accountId, note.reblog_of_id) !== undefined;
            if (!removed) throw new NotFound();

            return { status: 200, body: status };
        },
    }),
];
