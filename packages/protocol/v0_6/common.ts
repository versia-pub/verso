import { z } from "zod";

/** An optional field. Peers may leave it out or set it to null (see docs/decisions/0005). */
export const optional = <T extends z.ZodType>(
  schema: T,
): z.ZodOptional<z.ZodNullable<T>> => schema.nullish();

/** https://versia.pub/entities#entity-definition */
export const Id = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** A date and time with a time zone, as RFC 3339 requires. */
export const Rfc3339 = z.iso.datetime({ offset: true });

/** Whole numbers from 0, for the spec's `u64` fields. */
const Unsigned = z.number().int().nonnegative();

/** Keys are `namespace:name`, such as `pub.versia:custom_emojis`. https://versia.pub/extensions#naming */
export const Extensions = z.record(
  z.string().regex(/^[a-z0-9.-]+:[a-z0-9_]+$/),
  z.unknown(),
);

/** https://versia.pub/structures/content-format */
export const ContentFormat = z.record(
  z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  z.object({
    content: z.string(),
    remote: z.boolean(),
    description: optional(z.string()),
    size: optional(Unsigned),
    hash: optional(z.string().regex(/^[0-9a-fA-F]{64}$/)),
    thumbhash: optional(z.string()),
    width: optional(Unsigned),
    height: optional(Unsigned),
    fps: optional(Unsigned),
    duration: optional(z.number().nonnegative()),
  }),
);
export type ContentFormat = z.infer<typeof ContentFormat>;

/** The fields every entity has. Transient entities, such as Follow, have no `id`. */
export const Entity = z.object({
  id: Id,
  type: z.string(),
  created_at: Rfc3339,
  $schema: optional(z.url()),
  extensions: optional(Extensions),
});
export type Entity = z.infer<typeof Entity>;
