import { z } from "zod";
import { optional, ReferenceText, TransientEntity } from "./common.ts";

/**
 * Deletes the entity `deleted`.
 *
 * The spec's table requires `author`, but its changelog made "null authors" optional. Here a
 * missing author means the instance that signed the request.
 * @see https://versia.pub/entities/delete
 */
export const Delete = TransientEntity.extend({
    type: z.literal("Delete"),
    author: optional(ReferenceText),
    deleted_type: z.string(),
    deleted: ReferenceText,
});
export type Delete = z.infer<typeof Delete>;
