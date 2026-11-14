import { z } from "zod";
import { Entity, Integer, ReferenceText } from "./common.ts";

/**
 * One page of entities, like a user's notes. Every item must be authored on the instance serving
 * it, which the caller checks.
 *
 * Items keep all their fields, so the caller can parse them with the schema it expects.
 * @see https://versia.pub/structures/collection
 */
export const Collection = z.object({
    total: Integer,
    items: z.array(Entity.loose()),
});
export type Collection = z.infer<typeof Collection>;

/**
 * One page of references, like a user's subscribers.
 * @see https://versia.pub/structures/collection#reference-collection
 */
export const ReferenceCollection = z.object({
    total: Integer,
    items: z.array(ReferenceText),
});
export type ReferenceCollection = z.infer<typeof ReferenceCollection>;
