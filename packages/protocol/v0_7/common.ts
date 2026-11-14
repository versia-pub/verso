import { z } from "zod";
import { isDomain, parseReference } from "./reference.ts";

/** An optional field. Peers may leave it out or set it to null. */
export const optional = <T extends z.ZodType>(
    schema: T,
): z.ZodOptional<z.ZodNullable<T>> => schema.nullish();

/**
 * An entity id: 1 to 18 lowercase letters, digits, `_` and `-`.
 * @see https://versia.pub/entities#definition
 */
export const Id = z.string().regex(/^[a-z0-9_-]{1,18}$/);

/** A date and time with a time zone, as RFC 3339 requires. */
export const Rfc3339 = z.iso.datetime({ offset: true });

/**
 * A whole number from 0 to 2⁵³−1, the spec's `integer`. `1e3` and `1000.0` are valid, and parse
 * to the same number as `1000`.
 * @see https://versia.pub/json#numbers
 */
export const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * A lowercase hostname with no port, like `example.com`.
 * @see https://versia.pub/entities#domain
 */
export const Domain = z.string().refine(isDomain, "Invalid domain");

/**
 * A reference, `domain:id`. The schema keeps it as text; `parseReference` splits it.
 * @see https://versia.pub/entities#reference
 */
export const ReferenceText = z.string().refine(
    (text) => parseReference(text) !== undefined,
    "Invalid reference",
);

/** A link to a web page or file. Other schemes, like javascript:, are rejected. */
export const WebUrl = z.url({ protocol: /^https?$/ });

/**
 * Formatted text, as an HTML fragment. The schema doesn't check the HTML: what isn't allowed is
 * removed when it is sanitised for display.
 * @see https://versia.pub/structures/rich-text
 */
export const RichText = z.string();

/**
 * Data from extensions. Keys are `namespace:name`, like `pub.versia:custom_emojis`, and each value
 * is an object.
 * @see https://versia.pub/extensions#naming
 */
export const Extensions = z.record(
    z.string().regex(/^[a-z0-9.-]+:[a-z0-9_]+$/),
    z.record(z.string(), z.unknown()),
);

/**
 * A file, with its media type and what a receiver needs to know before fetching it.
 * @see https://versia.pub/structures/media
 */
export const Media = z.object({
    url: WebUrl,
    media_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
    description: optional(z.string()),
    size: optional(Integer),
    hash: optional(z.string().regex(/^[0-9a-f]{64}$/)),
    thumbhash: optional(z.base64()),
    width: optional(Integer),
    height: optional(Integer),
    duration: optional(z.number().nonnegative()),
});
export type Media = z.infer<typeof Media>;

/** A Media whose media type starts with `prefix`, like "image/" for an avatar. */
export const mediaOf = (prefix: string): typeof Media =>
    Media.refine(
        (media) => media.media_type.toLowerCase().startsWith(prefix),
        `The media type must start with "${prefix}"`,
    );

/** The fields every entity has. */
export const Entity = z.object({
    id: Id,
    type: z.string(),
    created_at: Rfc3339,
    updated_at: optional(Rfc3339),
    extensions: optional(Extensions),
});
export type Entity = z.infer<typeof Entity>;

/**
 * An entity that can't be fetched or changed later, like Subscribe or Delete, so it has no `id` and
 * no `updated_at`.
 * @see https://versia.pub/entities#transient-entities
 */
export const TransientEntity = Entity.omit({ id: true, updated_at: true });
export type TransientEntity = z.infer<typeof TransientEntity>;
