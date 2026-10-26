/**
 * This instance's key pair, which signs everything it sends over Versia. Every key comes from
 * here, so per-user keys, which other protocols need, can be added beside it.
 * @see https://versia.pub/signatures
 * @module
 */
import type { Context, InstanceKey } from "../kernel/context.ts";
import { deleteKeysBut, hasKeyRow, insertKeyRow, newestKeyRow } from "./key_queries.ts";

/** A private key, as kept, for signing. Importing one takes microseconds, so it isn't kept. */
const importPrivateKey = (pkcs8: string) =>
    crypto.subtle.importKey("pkcs8", Uint8Array.fromBase64(pkcs8), "Ed25519", false, ["sign"]);

/**
 * The current key: the newest, as the database has it now. It is read through `ctx.db`, so it
 * also works in a transaction. `ctx.federation.instanceKey` keeps it for a while.
 */
export const instanceKey = async (ctx: Context): Promise<InstanceKey> => {
    const row = await newestKeyRow(ctx);

    if (!row) throw new Error("This instance has no key yet. Run `verso migrate` to make one.");

    return {
        privateKey: await importPrivateKey(row.private_key),
        publicKey: row.public_key,
    };
};

/** Makes a new key pair and makes it current. Returns its id. */
export const createInstanceKey = async (
    ctx: Pick<Context, "db" | "clock" | "ids">,
): Promise<string> => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);

    // Ed25519 always makes a pair, but the type covers every algorithm.
    if (!("privateKey" in pair)) throw new Error("Ed25519 didn't make a key pair");

    const id = ctx.ids();

    await insertKeyRow(ctx, {
        id,
        public_key: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
            .toBase64(),
        private_key: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
            .toBase64(),
        created_at: ctx.clock.now(),
    });

    return id;
};

/**
 * Replaces the key pair with a new one, such as when the old one may have leaked, and returns the
 * new public key. The old pair is deleted, so it can't sign anything more. Other instances fetch
 * the new public key when a signature from this one stops verifying.
 */
export const rotateInstanceKey = async (ctx: Context): Promise<string> => {
    const publicKey = await ctx.transaction(async (tx) => {
        const id = await createInstanceKey(tx);
        await deleteKeysBut(tx, id);

        return (await instanceKey(tx)).publicKey;
    });
    // Once it is committed, so the old key isn't read again in the meantime.
    ctx.federation.forget();

    return publicKey;
};

/** Makes the instance's first key pair, unless it has one. Returns whether it made one. */
export const ensureInstanceKey = async (
    ctx: Pick<Context, "db" | "clock" | "ids">,
): Promise<boolean> => {
    if (await hasKeyRow(ctx)) return false;

    await createInstanceKey(ctx);
    return true;
};
