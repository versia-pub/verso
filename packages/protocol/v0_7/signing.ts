/**
 * Signs and verifies Versia requests and responses.
 *
 * Signatures cover the raw body bytes, so verify the bytes exactly as they arrived, and send the
 * bytes exactly as they were signed. Parsing and re-serialising JSON in between breaks them.
 * @see https://versia.pub/signatures
 * @module
 */
import { isDomain } from "./reference.ts";

/** A request, or a response to one. Responses use the method, host and target of their request. */
export type SignedMessage = {
    /** Like "GET" or "post"; the case doesn't matter. */
    readonly method: string;
    /**
     * The lowercase domain the request is sent to. Its receiver uses its own domain, never `Host`.
     * A response uses the responding instance's own domain.
     */
    readonly host: string;
    /** The path and query exactly as in the request line, with no `?` when there is no query. */
    readonly target: string;
    /** Empty for GET requests. */
    readonly body: Uint8Array<ArrayBuffer>;
};

/** A missing, malformed, stale or wrong signature are all answered with 401. */
export type Verification =
    | { readonly ok: true; readonly signedBy: string }
    | { readonly ok: false };

/** The longest a signature stays valid, either side of its timestamp. */
const maxClockSkewSeconds = 5 * 60;

/** Imports an instance's public key from SPKI base64, as InstanceMetadata holds it. */
export const importPublicKey = async (
    spkiBase64: string,
): Promise<CryptoKey | undefined> => {
    try {
        return await crypto.subtle.importKey(
            "spki",
            Uint8Array.fromBase64(spkiBase64),
            "Ed25519",
            false,
            ["verify"],
        );
    } catch {
        return undefined;
    }
};

/** Returns the three Versia-* headers to put on `message`. */
export const sign = async (
    message: SignedMessage,
    privateKey: CryptoKey,
    signedBy: string,
    now: Date,
): Promise<Record<string, string>> => {
    const signedAt = Math.floor(now.getTime() / 1000).toString();

    const signature = await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        await signedText(message, signedAt),
    );

    return {
        "Versia-Signature": new Uint8Array(signature).toBase64(),
        "Versia-Signed-By": signedBy,
        "Versia-Signed-At": signedAt,
    };
};

/**
 * Validates the Versia-* headers on `message`. `publicKeyOf` looks up the public key of the
 * instance named in Versia-Signed-By, which is also what `signedBy` holds on success. It is only
 * called once the headers and timestamp have been validated, and only with a domain name, never
 * an IP address or a port, so a request can't point it at an address inside Verso's own network.
 *
 * A response must also be signed by the instance the request went to. That's `message.host`, and
 * the caller compares it with `signedBy`.
 */
export const verify = async (
    message: SignedMessage,
    headers: Headers,
    publicKeyOf: (domain: string) => Promise<CryptoKey | undefined>,
    now: Date,
): Promise<Verification> => {
    const signature = headers.get("Versia-Signature") ?? "";
    const signedBy = headers.get("Versia-Signed-By") ?? "";
    const signedAt = headers.get("Versia-Signed-At") ?? "";

    if (
        // Standard base64 with padding, 64 bytes long, as every Ed25519 signature is.
        !/^[A-Za-z0-9+/]{86}==$/.test(signature) || !isDomain(signedBy) ||
        !/^(0|[1-9][0-9]*)$/.test(signedAt) ||
        Math.abs(now.getTime() / 1000 - Number(signedAt)) > maxClockSkewSeconds
    ) {
        return { ok: false };
    }

    const publicKey = await publicKeyOf(signedBy);
    let valid = false;
    try {
        valid = publicKey !== undefined && await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            Uint8Array.fromBase64(signature),
            await signedText(message, signedAt),
        );
    } catch {
        // The key can't be used for Ed25519, so it can't have made this signature.
    }

    return valid ? { ok: true, signedBy } : { ok: false };
};

/**
 * `$method $host $target $timestamp $sha256`, the text a signature covers.
 * @see https://versia.pub/signatures#calculating-the-signature
 */
const signedText = async (
    message: SignedMessage,
    signedAt: string,
): Promise<Uint8Array<ArrayBuffer>> => {
    const digest = await crypto.subtle.digest("SHA-256", message.body);

    return new TextEncoder().encode(
        `${message.method.toLowerCase()} ${message.host} ${message.target} ${signedAt} ${
            new Uint8Array(digest).toBase64()
        }`,
    );
};
