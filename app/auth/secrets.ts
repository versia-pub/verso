const base64url = (bytes: Uint8Array) =>
    bytes.toBase64({ alphabet: "base64url", omitPadding: true });

/** A new secret or token: 256 random bits, in base64url. */
export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * What is stored instead of a secret: its SHA-256. A fast hash is enough, since secrets are random
 * rather than chosen by people, so there is nothing to guess.
 */
export const hashToken = async (token: string): Promise<string> =>
    base64url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    );
