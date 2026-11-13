/**
 * Encrypting what is pushed so only the browser that subscribed can read it, as Web Push requires.
 * The content encoding is `aes128gcm` for subscriptions that say they are `standard`, and the older
 * `aesgcm` for the rest, like Mastodon.
 * @see https://www.rfc-editor.org/rfc/rfc8291
 * @see https://www.rfc-editor.org/rfc/rfc8188
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webpush-encryption-04
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

/** The size of a record that push services accept, from RFC 8291. */
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

/** The sender's public key, as an uncompressed point. */
export const senderKey = async (sender: Sender): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await crypto.subtle.exportKey("raw", sender.keyPair.publicKey));

/** The secret the sender and the browser agree on, with ECDH. */
const sharedSecret = async (keys: BrowserKeys, sender: Sender) => {
    const browserKey = await crypto.subtle.importKey("raw", keys.p256dh, curve, false, []);

    return new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: "ECDH", public: browserKey },
            sender.keyPair.privateKey,
            256,
        ),
    );
};

/** `record` encrypted with AES-GCM, by `cek` and `nonce`. */
const seal = async (
    cek: Uint8Array<ArrayBuffer>,
    nonce: Uint8Array<ArrayBuffer>,
    record: Uint8Array<ArrayBuffer>,
) => {
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);

    return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));
};

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

    const ownKey = await senderKey(sender);
    const shared = await sharedSecret(keys, sender);

    const ikm = await hkdf(
        keys.auth,
        shared,
        concat(encoder.encode("WebPush: info\0"), keys.p256dh, ownKey),
        32,
    );
    const cek = await hkdf(sender.salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(sender.salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

    // The last record ends with 2, and has no padding.
    const ciphertext = await seal(cek, nonce, concat(plaintext, new Uint8Array([2])));

    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, recordSize);

    return concat(sender.salt, size, new Uint8Array([ownKey.length]), ownKey, ciphertext);
};

/** A key's length, in two bytes, and the key, as the `aesgcm` context has them. */
const lengthPrefixed = (key: Uint8Array) => {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, key.length);

    return concat(length, key);
};

/**
 * `plaintext` encrypted for the browser with `keys`, as one record in the older `aesgcm` encoding.
 * The salt and the sender's key go in the `Encryption` and `Crypto-Key` headers instead.
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-webpush-encryption-04#section-3
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-encryption-encoding-03#section-2
 */
export const encryptLegacyPush = async (
    plaintext: Uint8Array,
    keys: BrowserKeys,
    sender: Sender,
): Promise<Uint8Array<ArrayBuffer>> => {
    if (plaintext.length > maxPlaintextBytes) throw new Error("Too much to push");

    const shared = await sharedSecret(keys, sender);
    const ikm = await hkdf(keys.auth, shared, encoder.encode("Content-Encoding: auth\0"), 32);
    const context = concat(
        encoder.encode("P-256\0"),
        lengthPrefixed(keys.p256dh),
        lengthPrefixed(await senderKey(sender)),
    );
    const cek = await hkdf(
        sender.salt,
        ikm,
        concat(encoder.encode("Content-Encoding: aesgcm\0"), context),
        16,
    );
    const nonce = await hkdf(
        sender.salt,
        ikm,
        concat(encoder.encode("Content-Encoding: nonce\0"), context),
        12,
    );

    // Two bytes saying there is no padding come first.
    return await seal(cek, nonce, concat(new Uint8Array(2), plaintext));
};
