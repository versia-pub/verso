/**
 * Points at an entity: its id, and the hostname of the instance that created it.
 * See https://versia.pub/types#reference.
 */
export interface Reference {
  readonly host: string;
  readonly id: string;
}

const idPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Parses a reference found inside an entity, such as a Note's `author`.
 *
 * `origin` is the hostname of the instance the entity came from: the one that signed the inbox
 * request, or served the entity we fetched. A bare id refers to an entity on that instance.
 * Returns undefined if the reference is invalid.
 */
export function parseReference(
  text: string,
  origin: string,
): Reference | undefined {
  // Ids can't contain a colon, but hostnames can (ports, IPv6), so split at the last one.
  const separator = text.lastIndexOf(":");
  const host = separator === -1 ? origin : text.slice(0, separator);
  const id = text.slice(separator + 1);

  const canonicalHost = canonicalize(host);
  if (canonicalHost === undefined || !idPattern.test(id)) {
    return undefined;
  }
  return { host: canonicalHost, id };
}

/**
 * Formats a reference to put inside an entity that `origin` will send or serve. The hostname is
 * left out when the referenced entity also lives on `origin`.
 */
export function formatReference(reference: Reference, origin: string): string {
  return reference.host === canonicalize(origin)
    ? reference.id
    : `${reference.host}:${reference.id}`;
}

/**
 * Returns the canonical form of a hostname with an optional port, as the URL parser writes it:
 * lowercase, IPv6 compressed, and without port 443 (the HTTPS default). Returns undefined for
 * non-ASCII names (the spec wants Punycode), unbracketed IPv6, and anything that isn't just a
 * hostname and port.
 */
function canonicalize(host: string): string | undefined {
  if (!/^[\x21-\x7e]+$/.test(host)) {
    return undefined;
  }
  const url = URL.parse(`https://${host}`);
  const onlyHost = url !== null && url.pathname === "/" && url.search === "" &&
    url.hash === "" && url.username === "" && url.password === "";
  return onlyHost ? url.host : undefined;
}
