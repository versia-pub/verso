/**
 * Signs and verifies Versia requests and responses.
 *
 * Signatures cover the raw body bytes, so verify the bytes exactly as they arrived, and send the
 * bytes exactly as they were signed. Parsing and re-serialising JSON in between breaks them.
 * @see https://versia.pub/signatures
 */
import { canonicalizeDomain } from "./reference.ts";

/** A request, or a response to one. Responses use the method and pathname of their request. */
export interface SignedMessage {
    /** Such as "GET" or "post"; the case doesn't matter. */
    readonly method: string;
    /** The URL-encoded path, as `URL.pathname` gives it. The query string isn't signed. */
    readonly pathname: string;
    /** Empty for GET requests. */
    readonly body: Uint8Array<ArrayBuffer>;
}

export type Verification =
    | { readonly ok: true; readonly signedBy: string }
    /** "invalid" means answering 401, "expired" means 422. */
    | { readonly ok: false; readonly reason: "invalid" | "expired" };

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
 * Checks the Versia-* headers on `message`. `publicKeyOf` looks up the public key of the
 * instance named in Versia-Signed-By, in canonical form (see `canonicalizeDomain`), which is also
 * what `signedBy` holds on success. It is only called once the headers and timestamp have been
 * checked, and only with a domain name, never an IP address or a port, so a request can.t point it
 * at an address inside Verso.s own network.
 */
export const verify = async (
    message: SignedMessage,
    headers: Headers,
    publicKeyOf: (domain: string) => Promise<CryptoKey | undefined>,
    now: Date,
): Promise<Verification> => {
    const signature = decodeSignature(headers.get("Versia-Signature"));
    const signedBy = canonicalizeDomain(headers.get("Versia-Signed-By") ?? "");
    const signedAt = headers.get("Versia-Signed-At");

    if (
        signature === undefined || signedBy === undefined ||
        signedAt === null ||
        !/^(0|[1-9][0-9]*)$/.test(signedAt)
    ) {
        return { ok: false, reason: "invalid" };
    }

    if (
        Math.abs(now.getTime() / 1000 - Number(signedAt)) > maxClockSkewSeconds
    ) {
        return { ok: false, reason: "expired" };
    }

    const publicKey = await publicKeyOf(signedBy);
    let valid = false;
    try {
        valid = publicKey !== undefined && await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            signature,
            await signedText(message, signedAt),
        );
    } catch {
        // The key can't be used for Ed25519, so it can't have made this signature.
    }

    return valid ? { ok: true, signedBy } : { ok: false, reason: "invalid" };
};

/** Ed25519 signatures are always 64 bytes. */
const decodeSignature = (
    base64: string | null,
): Uint8Array<ArrayBuffer> | undefined => {
    try {
        const bytes = Uint8Array.fromBase64(base64 ?? "");
        return bytes.length === 64 ? bytes : undefined;
    } catch {
        return undefined;
    }
};

/**
 * `$method $pathname $timestamp $sha256`, the text a signature covers.
 * @see https://versia.pub/signatures#calculating-the-signature
 */
const signedText = async (
    message: SignedMessage,
    signedAt: string,
): Promise<Uint8Array<ArrayBuffer>> => {
    const digest = await crypto.subtle.digest("SHA-256", message.body);

    return new TextEncoder().encode(
        `${message.method.toLowerCase()} ${message.pathname} ${signedAt} ${
            new Uint8Array(digest).toBase64()
        }`,
    );
};
