import { canonicalizeDomain, type Reference } from "../reference.ts";

export type { Reference };

const idPattern = /^[a-z0-9_-]{1,18}$/;

/**
 * Whether `text` is a domain as Versia writes it: already in canonical form, so lowercase, in
 * Punycode, and with no port, no trailing dot and no IP address.
 * @see https://versia.pub/entities#domain
 */
export const isDomain = (text: string): boolean => canonicalizeDomain(text) === text;

/**
 * Parses a reference, `domain:id`. Returns undefined if it is invalid, including when the domain
 * isn't lowercase or the id is too long.
 * @see https://versia.pub/entities#reference
 */
export const parseReference = (text: string): Reference | undefined => {
    // Neither a domain nor an id can contain a colon, so there is exactly one.
    const parts = text.split(":");
    if (parts.length !== 2) {
        return undefined;
    }

    const [host, id] = parts;
    return isDomain(host) && idPattern.test(id) ? { host, id } : undefined;
};

/** Formats a reference as `domain:id`. The domain is always written, even for local entities. */
export const formatReference = (reference: Reference): string =>
    `${reference.host}:${reference.id}`;
