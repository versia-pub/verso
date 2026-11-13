/**
 * The media proxy: remote media that isn't cached yet, at a URL of Verso's, which caches it on the
 * spot and redirects to it.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/controllers/media_proxy_controller.rb
 * @module
 */
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Redirect } from "../http/responses.ts";
import type { Context } from "../kernel/context.ts";
import { seenAmong } from "../notes/visibility.ts";
import { notesWith } from "./attachment_queries.ts";
import { findMedia } from "./media_queries.ts";
import { cacheNow } from "./remote_cache.ts";
import { fileUrl, proxied } from "./render.ts";

/**
 * The URL of the file of the remote media `id`, or of its preview if `small`, caching it first if
 * it isn't. It is `undefined` unless the media is attached to a status `viewerId` (or anyone if it
 * is `null`) may see, and is cached or can be now.
 */
const proxiedFile = async (
    ctx: Context,
    id: string,
    small: boolean,
    viewerId: string | null,
): Promise<string | undefined> => {
    let row = await findMedia(ctx, id);
    // Only remote media has a URL, and an instance to fetch it from.
    if (row === undefined || row.instance_id === null || row.url === null) return undefined;
    if ((await seenAmong(ctx, await notesWith(ctx, id), viewerId)).size === 0) return undefined;

    if (proxied(ctx, row)) {
        await cacheNow(ctx, { ...row, instance_id: row.instance_id, url: row.url }, false);
        row = await findMedia(ctx, id);
    }
    // Remote media has a file once cached.
    if (row?.sha256 == null) return undefined;

    return fileUrl(ctx, small ? row.preview_sha256 ?? row.sha256 : row.sha256);
};

const proxyRoute = (small: boolean) =>
    defineRoute({
        method: "GET",
        path: small ? "/media/proxy/:id/small" : "/media/proxy/:id",
        summary: small ? "Get remote media preview" : "Get remote media",
        description: small
            ? "Redirects to the preview of remote media attached to a status, caching it first."
            : "Redirects to the file of remote media attached to a status, caching it first.",
        tags: ["media"],
        auth: { require: "optional", scope: "read:statuses", permission: "read:note" },
        // Fetching from other instances is slow, so these requests are counted in their own bucket.
        rateLimit: { bucket: "media-proxy", times: 1 },
        params: z.object({ id: z.string() }),
        responses: { 302: Redirect },
        handler: async (ctx, { params, viewer }) => {
            const location = await proxiedFile(ctx, params.id, small, viewer?.accountId ?? null);
            if (location === undefined) throw new NotFound();

            return { status: 302, location };
        },
    });

export const mediaProxyRoutes: readonly Route[] = [proxyRoute(false), proxyRoute(true)];
