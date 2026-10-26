import { z } from "zod";
import { Entity, ReferenceText } from "./common.ts";

/**
 * `author` shares (boosts) the Note `shared` with their followers.
 * @see https://versia.pub/extensions/share
 */
export const Share = Entity.extend({
    type: z.literal("pub.versia:share/Share"),
    author: ReferenceText,
    shared: ReferenceText,
});
export type Share = z.infer<typeof Share>;
