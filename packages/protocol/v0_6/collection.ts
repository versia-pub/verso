import { z } from "zod";
import { Entity, optional, ReferenceText, Unsigned } from "./common.ts";

/**
 * One page of entities, such as a user's outbox. https://versia.pub/structures/collection
 *
 * Items keep all their fields, so the caller can parse them with the schema it expects.
 */
export const Collection = z.object({
  author: optional(ReferenceText),
  total: Unsigned,
  items: z.array(Entity.loose()),
});
export type Collection = z.infer<typeof Collection>;

/** One page of references, such as a user's followers. https://versia.pub/structures/collection#uri-collection */
export const URICollection = z.object({
  author: optional(ReferenceText),
  total: Unsigned,
  items: z.array(ReferenceText),
});
export type URICollection = z.infer<typeof URICollection>;
