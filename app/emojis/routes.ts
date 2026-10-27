/**
 * The client API's custom emojis.
 * @module
 */
import { CustomEmoji, VersiaEmoji } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Text } from "../http/schemas.ts";
import type { Limits, MediaLimits } from "../kernel/config_sections.ts";
import { shortcodePattern } from "../kernel/markup.ts";
import { MediaDescription } from "../media/routes.ts";
import { findLocalEmoji, localEmojis } from "./emoji_queries.ts";
import { addEmoji, changeEmoji, findEmojiFor } from "./emojis.ts";
import { renderEmojis, renderVersiaEmoji } from "./render.ts";

/** Room for the form's other fields and boundaries, besides the picture. */
const formBytes = 64 * 1024;

/** Versia Server's emoji routes, which Verso's routes follow. */
const versiaServerEmojis =
    "https://github.com/versia-pub/server/tree/main/packages/api/routes/api/v1/emojis";

/**
 * An emoji's fields as Versia Server accepts them, with a picture at most as large as `media`
 * allows, named as text can use it, at most as long as Versia Server allows.
 */
const emojiFields = (media: MediaLimits, limits: Limits) => ({
    shortcode: z.string()
        .regex(new RegExp(`^${shortcodePattern}$`), {
            error: "Must be at least 2 letters, digits or underscores",
        })
        .max(100),
    element: z.file().max(media.max_emoji_bytes, {
        error: `Must be at most ${media.max_emoji_bytes} bytes`,
    }).meta({ description: "The emoji's picture." }),
    category: Text(64).optional(),
    alt: MediaDescription(limits).optional(),
});

const EmojiId = z.object({ id: z.string() });

/** Who is asking, as the emoji services need them. */
const editorOf = async (viewer: RouteViewer & { readonly accountId: string }) => ({
    accountId: viewer.accountId,
    managesEmojis: (await viewer.permissions()).has("emojis"),
});

/** Custom emojis, with pictures held to `media` and alt text to `limits`. */
export const emojiRoutes = (media: MediaLimits, limits: Limits): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/api/v1/custom_emojis",
        summary: "This instance's custom emojis, for the picker",
        tags: ["emojis"],
        responses: { 200: z.array(CustomEmoji) },
        handler: async (ctx) => ({ status: 200, body: renderEmojis(ctx, await localEmojis(ctx)) }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/emojis",
        summary: "Upload emoji",
        description: "Upload a new emoji to the server.\n\n" +
            "The emoji is the user's own unless `global`, which needs the `emojis` permission. " +
            "Its picture is processed after the response, which is 202, without URLs; text " +
            `doesn't use the emoji until then. Pictures are at most ${media.max_emoji_bytes} ` +
            "bytes. A shortcode the user may already use, for their own emoji or a global one, " +
            "is answered with 422.",
        docs: versiaServerEmojis,
        tags: ["emojis"],
        auth: { require: "user", scope: "write:media", permission: "owner:emoji" },
        maxBodyBytes: media.max_emoji_bytes + formBytes,
        body: z.object({ ...emojiFields(media, limits), global: Flag.default(false) }),
        responses: { 202: VersiaEmoji },
        handler: async (ctx, { body, viewer }) => {
            const id = await addEmoji(ctx, await editorOf(viewer), {
                shortcode: body.shortcode,
                picture: body.element,
                description: body.alt,
                category: body.category,
                global: body.global,
            });
            const emoji = await findLocalEmoji(ctx, id);
            if (emoji === undefined) throw new NotFound();

            // Its picture is always processed by a job.
            return { status: 202, body: renderVersiaEmoji(ctx, emoji) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/emojis/:id",
        summary: "Get emoji",
        description: "Retrieves a custom emoji from database by ID.\n\n" +
            "Users see global emojis and their own; those with the `emojis` permission see any.",
        docs: versiaServerEmojis,
        tags: ["emojis"],
        auth: { require: "user", scope: "read", permission: "read:emoji" },
        params: EmojiId,
        responses: { 200: VersiaEmoji },
        handler: async (ctx, { params, viewer }) => {
            const emoji = await findEmojiFor(ctx, await editorOf(viewer), params.id);
            if (emoji === undefined) throw new NotFound();

            return { status: 200, body: renderVersiaEmoji(ctx, emoji) };
        },
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v1/emojis/:id",
        summary: "Modify emoji",
        description: "Edit image or metadata of an emoji.\n\n" +
            "Users change their own emojis; those with the `emojis` permission change any, and " +
            "make them global or not. A global emoji made not global becomes the editor's own. " +
            "Statuses that use a renamed emoji keep it. A new picture is processed after the " +
            "response, and the emoji has no URLs until then.",
        docs: versiaServerEmojis,
        tags: ["emojis"],
        auth: { require: "user", scope: "write:media", permission: "owner:emoji" },
        maxBodyBytes: media.max_emoji_bytes + formBytes,
        params: EmojiId,
        body: z.object({ ...emojiFields(media, limits), global: Flag }).partial(),
        responses: { 200: VersiaEmoji },
        handler: async (ctx, { body, params, viewer }) => {
            const emoji = await changeEmoji(ctx, await editorOf(viewer), params.id, {
                shortcode: body.shortcode,
                picture: body.element,
                description: body.alt,
                category: body.category,
                global: body.global,
            });
            if (emoji === undefined) throw new NotFound();

            return { status: 200, body: renderVersiaEmoji(ctx, emoji) };
        },
    }),
];
