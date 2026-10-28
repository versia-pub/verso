/**
 * The key pair this instance signs Web Push requests with, as VAPID. There is only ever one, as
 * changing it would break every subscription.
 * @see https://www.rfc-editor.org/rfc/rfc8292
 */
export type VapidKeysTable = {
    id: string;
    /** The P-256 public key, as an uncompressed point, in base64. */
    public_key: string;
    /** PKCS #8, in base64. */
    private_key: string;
    created_at: Date;
};
