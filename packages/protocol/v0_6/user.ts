import { z } from "zod";
import { contentFormatOf, Entity, optional } from "./common.ts";

const Text = contentFormatOf("text/");
const Image = contentFormatOf("image/");

/** https://versia.pub/entities/user */
export const User = Entity.extend({
    type: z.literal("User"),
    avatar: optional(Image),
    bio: optional(Text),
    display_name: optional(z.string()),
    fields: z.array(z.object({ key: Text, value: Text })),
    username: z.string().regex(/^[A-Za-z0-9_-]+$/),
    header: optional(Image),
    manually_approves_followers: z.boolean(),
    indexable: z.boolean(),
});
export type User = z.infer<typeof User>;
