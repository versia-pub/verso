import { z } from "zod";
import { contentFormatOf, Entity, optional, ReferenceText, WebUrl } from "./common.ts";

/** https://versia.pub/entities/note */
export const Note = Entity.extend({
    type: z.literal("Note"),
    attachments: z.array(contentFormatOf("", true)),
    author: ReferenceText,
    category: optional(
        z.enum([
            "microblog",
            "forum",
            "blog",
            "image",
            "video",
            "audio",
            "messaging",
        ]),
    ),
    content: optional(contentFormatOf("text/", false)),
    device: optional(z.object({
        name: z.string(),
        version: optional(z.string()),
        url: optional(WebUrl),
    })),
    /**
     * "public", "followers", or a reference to a group. "public" and "followers" are also valid
     * bare ids, so the schema can't tell them apart; the code that reads the note does.
     */
    group: optional(ReferenceText),
    is_sensitive: z.boolean(),
    mentions: z.array(ReferenceText),
    previews: z.array(z.object({
        link: WebUrl,
        title: z.string(),
        description: optional(z.string()),
        image: optional(WebUrl),
        icon: optional(WebUrl),
    })),
    quotes: optional(ReferenceText),
    replies_to: optional(ReferenceText),
    subject: optional(z.string()),
});
export type Note = z.infer<typeof Note>;
