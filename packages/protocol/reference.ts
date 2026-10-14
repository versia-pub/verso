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
 * Lowercases a hostname, with an optional port, and checks that the URL parser leaves it as it is.
 * That rejects non-ASCII names (the spec wants Punycode), unbracketed IPv6, port 443 (the HTTPS
 * default, never written out) and anything that isn't a hostname.
 */
function canonicalize(host: string): string | undefined {
  const lowercase = host.toLowerCase();
  return URL.parse(`https://${lowercase}`)?.host === lowercase
    ? lowercase
    : undefined;
}
