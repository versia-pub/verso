import { z } from "zod";
import { Entity, mediaOf, optional, WebUrl } from "./common.ts";

/**
 * A user on any instance. The bio and fields are in {@link Profile}, and the header is in
 * {@link Decorations}.
 * @see https://versia.pub/entities/user
 */
export const User = Entity.extend({
    type: z.literal("User"),
    avatar: optional(mediaOf("image/")),
    display_name: optional(z.string()),
    username: z.string().regex(/^[A-Za-z0-9_-]+$/),
    manually_approves_subscribers: z.boolean(),
    indexable: z.boolean(),
    /** The user's profile page on their instance. */
    url: optional(WebUrl),
});
export type User = z.infer<typeof User>;
