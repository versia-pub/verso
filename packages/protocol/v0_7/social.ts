import { z } from "zod";
import { Entity, Media, optional, ReferenceText, RichText, WebUrl } from "./common.ts";

/** The key of the Social extension, as InstanceMetadata lists it. */
export const socialKey = "pub.versia:social";

const categories = ["microblog", "forum", "blog", "image", "video", "audio", "messaging"] as const;

/**
 * A status, as the Social extension's Note.
 *
 * `visibility` goes from widest to narrowest: `public`, `unlisted`, `subscribers` and `mentions`.
 * An unknown `category` is read as if it were left out.
 * @see https://versia.pub/extensions/social#note
 */
export const Note = Entity.extend({
    type: z.literal("pub.versia:social/Note"),
    attachments: z.array(Media),
    author: ReferenceText,
    category: optional(z.string()).transform((value) =>
        categories.find((category) => category === value)
    ),
    content: optional(RichText),
    device: optional(z.object({
        name: z.string(),
        version: optional(z.string()),
        url: optional(WebUrl),
    })),
    visibility: z.enum(["public", "unlisted", "subscribers", "mentions"]),
    is_sensitive: z.boolean(),
    mentions: z.array(ReferenceText),
    previews: z.array(z.object({
        link: WebUrl,
        title: z.string(),
        description: optional(z.string()),
        image: optional(WebUrl),
        icon: optional(WebUrl),
    })),
    quoting: optional(ReferenceText),
    replies_to: optional(ReferenceText),
    /** Plain text, not RichText. */
    subject: optional(z.string()),
    /** The note's page on its instance. */
    url: optional(WebUrl),
});
export type Note = z.infer<typeof Note>;
