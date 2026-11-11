/**
 * Signing pushes as this instance, with VAPID, so push services know who sends them.
 * @see https://www.rfc-editor.org/rfc/rfc8292
 * @module
 */
import { SignJWT } from "@panva/jose";
import type { VapidKey } from "../kernel/context.ts";

/** How long a signature lasts. RFC 8292 allows at most a day. */
const validMs = 12 * 60 * 60 * 1000;

/**
 * The JWT for a push to `endpoint` at `now`, signed by `key`, and naming `subject`, a URL to reach
 * the instance's admins by, such as its own.
 * @see https://www.rfc-editor.org/rfc/rfc8292#section-2
 */
export const vapidJwt = (
    key: VapidKey,
    endpoint: string,
    subject: string,
    now: Date,
): Promise<string> =>
    new SignJWT({ sub: subject })
        .setProtectedHeader({ typ: "JWT", alg: "ES256" })
        .setAudience(new URL(endpoint).origin)
        .setExpirationTime(Math.floor((now.getTime() + validMs) / 1000))
        .sign(key.privateKey);

/**
 * The `Authorization` header for a standard push, with the JWT and the key that verifies it.
 * @see https://www.rfc-editor.org/rfc/rfc8292#section-3
 */
export const vapidAuthorization = (jwt: string, key: VapidKey): string =>
    `vapid t=${jwt}, k=${key.publicKey.toBase64({ alphabet: "base64url", omitPadding: true })}`;
