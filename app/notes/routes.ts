import { Status } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import type { Limits } from "../kernel/config.ts";
import { countText } from "../kernel/markup.ts";
import { postNote, removeNote, visibleNote } from "./notes.ts";
import { renderStatuses } from "./render.ts";

/** What Verso can't post yet, refused rather than left out: empty, or not given at all. */
const NotYet = (what: string) =>
    z.unknown().refine(
        (value) =>
            value === undefined || value === null || value === "" ||
            (Array.isArray(value) && value.length === 0),
        { error: `${what} aren't supported yet` },
    ).optional();

/**
 * What a new status may say, with it and its content warning at most `limits.status` long
 * together. It is written in plain text, unless `content_type` says Markdown, as on Pleroma. Quote
 * policies are left out; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
const draft = (limits: Limits) =>
    z.object({
        status: z.string().refine((text) => text.trim() !== "", { error: "Can't be blank" }),
        content_type: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
        spoiler_text: z.string().default(""),
        sensitive: Flag.optional(),
        visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
        /** Empty or `null` for the author's default. */
        language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).nullish(),
        in_reply_to_id: z.string().nullish(),
        media_ids: NotYet("Attachments"),
        poll: NotYet("Polls"),
        scheduled_at: NotYet("Scheduled statuses"),
    }).refine(
        (body) => countText(body.status) + countText(body.spoiler_text) <= limits.status,
        { error: `Must be at most ${limits.status} characters`, path: ["status"] },
    );

/** Statuses: posting, viewing and deleting them, with what is posted held to `limits`. */
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

            const [status] = await renderStatuses(ctx, [note], viewerId);
            return { status: 200, body: status };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/statuses/:id",
        summary: "Deletes one of the viewer's statuses, and gives it back as written, to redraft",
        tags: ["statuses"],
        auth: { require: "user", scope: "write:statuses", permission: "owner:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: Status },
        handler: async (ctx, { params, viewer }) => {
            const note = await visibleNote(ctx, params.id, viewer.accountId);
            if (note?.account_id !== viewer.accountId) throw new NotFound();

            const [status] = await renderStatuses(ctx, [note], viewer.accountId, { source: true });
            if (!await removeNote(ctx, note.id)) throw new NotFound();

            return { status: 200, body: status };
        },
    }),
];
