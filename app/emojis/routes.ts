/**
 * The client API's custom emojis.
 * @module
 */
import { CustomEmoji, VersiaEmoji } from "@versia/client-api";
import { z } from "zod";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Text } from "../http/schemas.ts";
import type { Limits, MediaLimits } from "../kernel/config_sections.ts";
import { shortcodePattern } from "../kernel/markup.ts";
import { MediaDescription } from "../media/routes.ts";
import { findLocalEmoji, localEmojis } from "./emoji_queries.ts";
import { addEmoji } from "./emojis.ts";
import { renderEmojis, renderVersiaEmoji } from "./render.ts";

/** Room for the form's other fields and boundaries, besides the picture. */
const formBytes = 64 * 1024;

/** Versia Server's emoji routes, which Verso's routes follow. */
const versiaServerEmojis =
    "https://github.com/versia-pub/server/tree/main/packages/api/routes/api/v1/emojis";

/**
 * A new emoji as Versia Server accepts it, with a picture at most as large as `media` allows, named
 * as text can use it, at most as long as Versia Server allows.
 */
const NewEmojiBody = (media: MediaLimits, limits: Limits) =>
    z.object({
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
        global: Flag.default(false),
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
        body: NewEmojiBody(media, limits),
        responses: { 202: VersiaEmoji },
        handler: async (ctx, { body, viewer }) => {
            if (body.global && !(await viewer.permissions()).has("emojis")) {
                throw new NotPermitted("Only users with the emojis permission add global emojis");
            }

            const id = await addEmoji(ctx, viewer.accountId, {
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
];
