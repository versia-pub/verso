/**
 * The key pair this instance signs Web Push requests with, as VAPID, so push services know they
 * come from it. Clients subscribe with its public half.
 * @see https://www.rfc-editor.org/rfc/rfc8292
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { findVapidKeyRow, insertVapidKeyRow } from "./key_queries.ts";

/** A key to sign Web Push requests with, and its public half as an uncompressed point. */
export type VapidKey = {
    readonly privateKey: CryptoKey;
    readonly publicKey: Uint8Array<ArrayBuffer>;
};

const algorithm = { name: "ECDSA", namedCurve: "P-256" };

const row = async (ctx: Pick<Context, "db">) => {
    const found = await findVapidKeyRow(ctx);
    if (!found) {
        throw new Error("This instance has no VAPID key yet. Run `verso migrate` to make one.");
    }

    return found;
};

/** The key pair. Importing it takes microseconds, so it isn't cached. */
export const vapidKey = async (ctx: Pick<Context, "db">): Promise<VapidKey> => {
    const { public_key, private_key } = await row(ctx);

    return {
        privateKey: await crypto.subtle.importKey(
            "pkcs8",
            Uint8Array.fromBase64(private_key),
            algorithm,
            false,
            ["sign"],
        ),
        publicKey: Uint8Array.fromBase64(public_key),
    };
};

/** The public key as clients subscribe with it, in URL-safe base64, as Mastodon shows it. */
export const vapidPublicKey = async (ctx: Pick<Context, "db">): Promise<string> =>
    Uint8Array.fromBase64((await row(ctx)).public_key).toBase64({ alphabet: "base64url" });

/** Generates the key pair, unless there is one. Returns whether it generated one. */
export const ensureVapidKey = async (
    ctx: Pick<Context, "db" | "clock" | "ids">,
): Promise<boolean> => {
    if (await findVapidKeyRow(ctx)) return false;

    const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    await insertVapidKeyRow(ctx, {
        id: ctx.ids(),
        public_key: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)).toBase64(),
        private_key: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
            .toBase64(),
        created_at: ctx.clock.now(),
    });

    return true;
};
