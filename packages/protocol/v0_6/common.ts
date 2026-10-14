import { z } from "zod";
import { parseReference } from "../reference.ts";

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

/**
 * A ContentFormat whose MIME types all start with `prefix`, such as "image/" for an avatar, and
 * whose entries all have the given `remote` value, if one is given.
 */
export const contentFormatOf = (
  prefix: string,
  remote?: boolean,
): typeof ContentFormat =>
  ContentFormat.refine(
    (formats) =>
      Object.entries(formats).every(([type, format]) =>
        type.startsWith(prefix) &&
        (remote === undefined || format.remote === remote)
      ),
    remote === undefined
      ? `Every MIME type must start with "${prefix}"`
      : `Every MIME type must start with "${prefix}" and have remote: ${remote}`,
  );

/**
 * A reference as it is written inside an entity: `host:id` or a bare `id`. The schema only checks
 * the syntax; parseReference turns it into a host and id once the entity's origin is known.
 */
export const ReferenceText = z.string().refine(
  // Any valid hostname works as the origin here, because it is only used for bare ids.
  (text) => parseReference(text, "origin.invalid") !== undefined,
  "Invalid reference",
);

/** A link to a web page or image. Other schemes, such as javascript:, are rejected. */
export const WebUrl = z.url({ protocol: /^https?$/ });

/** The fields every entity has. Transient entities, such as Follow, have no `id`. */
export const Entity = z.object({
  id: Id,
  type: z.string(),
  created_at: Rfc3339,
  $schema: optional(z.url()),
  extensions: optional(Extensions),
});
export type Entity = z.infer<typeof Entity>;
