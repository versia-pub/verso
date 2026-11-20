/**
 * Points at an entity: its id, and the domain of the instance that created it.
 * @see https://versia.pub/entities#reference
 */
export type Reference = {
    readonly host: string;
    readonly id: string;
};

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

/**
 * Returns the canonical form of a hostname, as the URL parser writes it: lowercase, IPv6
 * compressed, and without port 443 (the HTTPS default). Returns undefined for non-ASCII names
 * (the spec wants Punycode), unbracketed IPv6, and anything that isn't just a hostname and port.
 */
const canonicalize = (host: string): string | undefined => {
    if (!/^[\x21-\x7e]+$/.test(host)) {
        return undefined;
    }

    const url = URL.parse(`https://${host}`);
    const onlyHost = url !== null && url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" && url.username === "" && url.password === "";

    return onlyHost ? url.host : undefined;
};

/**
 * Returns the canonical form of a domain, as `Versia-Signed-By` gives it, or undefined if it isn't
 * one: a name with at least two labels, whose last has a letter, and no port. An IP address or a
 * single label like `localhost` isn't accepted, since the instance a domain names is fetched from,
 * which must not reach into Verso's own network.
 * @see https://versia.pub/entities#domain
 */
export const canonicalizeDomain = (domain: string): string | undefined => {
    const host = canonicalize(domain);
    return host !== undefined && /^([a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/.test(host)
        ? host
        : undefined;
};
