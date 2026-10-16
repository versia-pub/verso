/**
 * This instance's key pair, which signs everything it sends over Versia. Every key comes from
 * here, so per-user keys, which other protocols need, can be added beside it.
 * @see https://versia.pub/signatures
 * @module
 */
import type { Context } from "../kernel/context.ts";

/** The key to sign as this instance with, and its public half as InstanceMetadata shows it. */
export type InstanceKey = {
    readonly privateKey: CryptoKey;
    /** SPKI, in base64. */
    readonly publicKey: string;
};

/** Imported private keys, by key id. A key's row never changes, so neither does its entry. */
const imported = new Map<string, Promise<CryptoKey>>();

const importPrivateKey = (id: string, pkcs8: string) => {
    let key = imported.get(id);
    if (!key) {
        key = crypto.subtle.importKey("pkcs8", Uint8Array.fromBase64(pkcs8), "Ed25519", false, [
            "sign",
        ]);
        imported.set(id, key);
    }

    return key;
};

/**
 * The current key: the newest. It is read through `ctx.db`, so it also works in a transaction,
 * and a rotated key is used from the next request on.
 */
export const instanceKey = async (ctx: Context): Promise<InstanceKey> => {
    const row = await ctx.db.selectFrom("instance_keys")
        .select(["id", "public_key", "private_key"])
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();

    if (!row) throw new Error("This instance has no key yet. Run `verso migrate` to make one.");

    return {
        privateKey: await importPrivateKey(row.id, row.private_key),
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

    await ctx.db.insertInto("instance_keys")
        .values({
            id,
            public_key: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
                .toBase64(),
            private_key: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
                .toBase64(),
            created_at: ctx.clock.now(),
        })
        .execute();

    return id;
};

/**
 * Replaces the key pair with a new one, such as when the old one may have leaked, and returns the
 * new public key. The old pair is deleted, so it can't sign anything more. Other instances fetch
 * the new public key when a signature from this one stops verifying.
 */
export const rotateInstanceKey = (ctx: Context): Promise<string> =>
    ctx.transaction(async (tx) => {
        const id = await createInstanceKey(tx);
        await tx.db.deleteFrom("instance_keys").where("id", "!=", id).execute();

        return (await instanceKey(tx)).publicKey;
    });

/** Makes the instance's first key pair, unless it has one. Returns whether it made one. */
export const ensureInstanceKey = async (
    ctx: Pick<Context, "db" | "clock" | "ids">,
): Promise<boolean> => {
    const existing = await ctx.db.selectFrom("instance_keys").select("id").limit(1)
        .executeTakeFirst();
    if (existing) return false;

    await createInstanceKey(ctx);
    return true;
};
