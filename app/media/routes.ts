import { MediaAttachment } from "@versia/client-api";
import { z } from "zod";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { Binary, defineRoute, Redirect, type Route } from "../http/route.ts";
import { Text } from "../http/schemas.ts";
import type { MediaLimits } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import type { MediaRow } from "./media.ts";
import { renderAttachment } from "./render.ts";
import { serveFile } from "./serving.ts";
import { findUpload } from "./upload_queries.ts";
import { describeUpload, processingFailed, upload } from "./uploads.ts";

/** How long alt text may be, as on Mastodon. */
const descriptionLimit = 4000;

/** Room for a form's other fields, and its boundaries, beside the file. */
const formBytes = 64 * 1024;

/** A file's alt text, as Mastodon takes it. */
export const MediaDescription: z.ZodType<string, string> = Text(descriptionLimit).meta({
    description: "A plain-text description of the media, for accessibility purposes.",
});

/** A point as Mastodon writes it, such as `0.5,-0.25`, from -1 to 1 on each axis. */
export const FocusPoint = z.string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, { error: "Must be two numbers, such as 0.5,-0.25" })
    .transform((point) => point.split(",").map(Number))
    .refine((point) => point.every((n) => n >= -1 && n <= 1), {
        error: "Must be from -1 to 1 on each axis",
    })
    .transform(([x, y]) => ({ x, y }))
    .meta({
        description: "Two floating points (x,y), comma-delimited, ranging from -1.0 to 1.0.",
    });

/**
 * A file to upload, as Mastodon takes it. Thumbnails, which Mastodon takes for videos and audio,
 * aren't taken yet.
 * @see https://docs.joinmastodon.org/methods/media/#v2
 */
const UploadBody = (limits: MediaLimits) =>
    z.object({
        file: z.file().max(limits.max_upload_bytes, {
            error: `Must be at most ${limits.max_upload_bytes} bytes`,
        }).meta({ description: "The file to be attached." }),
        thumbnail: z.unknown()
            .refine((value) => value === undefined || value === "", {
                error: "Thumbnails aren't supported yet",
            })
            .optional(),
        description: MediaDescription.optional(),
        focus: FocusPoint.optional(),
    });

/** @see https://docs.joinmastodon.org/methods/media/#update */
const DescriptionBody = z.object({
    description: MediaDescription.optional(),
    focus: FocusPoint.optional(),
});

const MediaId = z.object({ id: z.string() });

/**
 * The upload, with 200 once it is processed, or 206 while it is, as Mastodon answers. A picture
 * that couldn't be processed is refused with 422, as on Mastodon.
 */
const progressOf = (ctx: Context, row: MediaRow) => {
    if (processingFailed(row)) {
        throw new Unprocessable("Error processing thumbnail for uploaded media");
    }

    return row.processed_at === null
        ? { status: 206 as const, body: renderAttachment(ctx, row) }
        : { status: 200 as const, body: renderAttachment(ctx, row) };
};

/** Uploading files, with what is uploaded held to `limits`, and describing them. */
export const mediaRoutes = (limits: MediaLimits): readonly Route[] => [
    defineRoute({
        method: "POST",
        path: "/api/v2/media",
        summary: "Upload media as an attachment (async)",
        description: "Creates a media attachment to be used with a new status. The full sized " +
            "media will be processed asynchronously in the background for large uploads.\n\n" +
            "Pictures are processed, and answered with 202 until they are; any other file is " +
            "kept as it is, as a file of type `unknown`. A picture that can't be processed is " +
            "removed, as it may hold metadata, and then answered with 422. Files are at most " +
            `${limits.max_upload_bytes} bytes.`,
        docs: "https://docs.joinmastodon.org/methods/media/#v2",
        tags: ["media"],
        auth: { require: "user", scope: "write:media", permission: "owner:media" },
        maxBodyBytes: limits.max_upload_bytes + formBytes,
        body: UploadBody(limits),
        responses: { 200: MediaAttachment, 202: MediaAttachment },
        handler: async (ctx, { body, viewer }) => {
            const row = await upload(ctx, viewer.accountId, {
                bytes: await body.file.bytes(),
                mediaType: body.file.type,
                description: body.description || undefined,
                focus: body.focus,
            });

            const reply = renderAttachment(ctx, row);
            return row.processed_at === null
                ? { status: 202, body: reply }
                : { status: 200, body: reply };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/media/:id",
        summary: "Get media attachment",
        description: "Get a media attachment, before it is attached to a status and posted, but " +
            "after it is accepted for processing. Use this method to check that the full-sized " +
            "media has finished processing.",
        docs: "https://docs.joinmastodon.org/methods/media/#get",
        tags: ["media"],
        auth: { require: "user", scope: "write:media", permission: "owner:media" },
        params: MediaId,
        responses: { 200: MediaAttachment, 206: MediaAttachment },
        handler: async (ctx, { params, viewer }) => {
            const row = await findUpload(ctx, params.id, viewer.accountId);
            if (row === undefined) throw new NotFound();

            return progressOf(ctx, row);
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/media/:id",
        summary: "Update media attachment",
        description: "Update a MediaAttachment's parameters, before it is attached to a status " +
            "and posted.\n\nAn empty description clears it.",
        docs: "https://docs.joinmastodon.org/methods/media/#update",
        tags: ["media"],
        auth: { require: "user", scope: "write:media", permission: "owner:media" },
        params: MediaId,
        body: DescriptionBody,
        responses: { 200: MediaAttachment, 206: MediaAttachment },
        handler: async (ctx, { params, body, viewer }) => {
            const row = await describeUpload(ctx, viewer.accountId, params.id, body);
            if (row === undefined) throw new NotFound();

            return progressOf(ctx, row);
        },
    }),
    defineRoute({
        method: "GET",
        path: "/media/:key",
        summary: "A file someone uploaded, or its preview",
        description: "Files are kept under the SHA-256 of their bytes, so they never change. " +
            "Pictures are served as pictures; any other file is served for browsers to save, " +
            "as `application/octet-stream`. Where the store serves files itself, such as " +
            "through a CDN, this redirects there.",
        tags: ["media"],
        immutable: true,
        rateLimit: false,
        params: z.object({ key: z.string() }),
        responses: { 200: Binary("application/octet-stream"), 302: Redirect },
        handler: async (ctx, { params }) => {
            const file = await serveFile(ctx, params.key);
            if (file === undefined) throw new NotFound();
            if ("location" in file) return { status: 302, location: file.location };

            return {
                status: 200,
                file: file.stream,
                type: file.mediaType,
                ...file.download && { download: true as const },
            };
        },
    }),
];
