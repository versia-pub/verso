/**
 * The client API's custom emojis.
 * @module
 */
import { CustomEmoji } from "@versia/client-api";
import { z } from "zod";
import { defineRoute, type Route } from "../http/route.ts";
import { localEmojis } from "./emoji_queries.ts";
import { renderEmojis } from "./render.ts";

export const emojiRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/custom_emojis",
        summary: "This instance's custom emojis, for the picker",
        tags: ["emojis"],
        responses: { 200: z.array(CustomEmoji) },
        handler: async (ctx) => ({ status: 200, body: renderEmojis(await localEmojis(ctx)) }),
    }),
];
