/**
 * Encrypting what is pushed so only the browser that subscribed can read it, as Web Push requires,
 * in the `aes128gcm` content encoding.
 * @see https://www.rfc-editor.org/rfc/rfc8291
 * @see https://www.rfc-editor.org/rfc/rfc8188
 * @module
 */

/** The browser's keys, as it subscribed with them. */
export type BrowserKeys = {
    /** Its P-256 public key, as an uncompressed point. */
    readonly p256dh: Uint8Array<ArrayBuffer>;
    /** Its secret, of 16 bytes. */
    readonly auth: Uint8Array<ArrayBuffer>;
};

/** What encrypts one push: a key pair of its own, and a salt. Random unless tests choose them. */
export type Sender = { readonly keyPair: CryptoKeyPair; readonly salt: Uint8Array<ArrayBuffer> };

const curve = { name: "ECDH", namedCurve: "P-256" };

/** The size of a record, which push services take, as RFC 8291 has it. */
const recordSize = 4096;

/**
 * The most that can be pushed: the 4096 bytes push services must accept, less the header, AES-GCM's
 * tag and the record's delimiter.
 * @see https://www.rfc-editor.org/rfc/rfc8291#section-4
 */
export const maxPlaintextBytes = 3993;

const encoder = new TextEncoder();

const concat = (...parts: readonly Uint8Array[]) => {
    const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }

    return joined;
};

/** `length` bytes from HKDF with SHA-256. */
const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    length: number,
) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        key,
        length * 8,
    );

    return new Uint8Array(bits);
};

/** A new key pair and salt, for one push. */
export const randomSender = async (): Promise<Sender> => ({
    keyPair: await crypto.subtle.generateKey(curve, true, ["deriveBits"]),
    salt: crypto.getRandomValues(new Uint8Array(16)),
});

/**
 * `plaintext` encrypted for the browser with `keys`, as one record, with the header that says how
 * to decrypt it.
 */
export const encryptPush = async (
    plaintext: Uint8Array,
    keys: BrowserKeys,
    sender: Sender,
): Promise<Uint8Array<ArrayBuffer>> => {
    if (plaintext.length > maxPlaintextBytes) throw new Error("Too much to push");

    const browserKey = await crypto.subtle.importKey("raw", keys.p256dh, curve, false, []);
    const ownKey = new Uint8Array(await crypto.subtle.exportKey("raw", sender.keyPair.publicKey));
    const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: "ECDH", public: browserKey },
            sender.keyPair.privateKey,
            256,
        ),
    );

    const ikm = await hkdf(
        keys.auth,
        shared,
        concat(encoder.encode("WebPush: info\0"), keys.p256dh, ownKey),
        32,
    );
    const cek = await hkdf(sender.salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(sender.salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    // The last record ends with 2, and has no padding.
    const record = concat(plaintext, new Uint8Array([2]));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record);

    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, recordSize);

    return concat(
        sender.salt,
        size,
        new Uint8Array([ownKey.length]),
        ownKey,
        new Uint8Array(ciphertext),
    );
};
