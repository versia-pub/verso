import { Instance, Limits, MediaLimits } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import type { Server } from "../kernel/fake_transport.ts";
import type { AboutSettings } from "./render.ts";

/** A Versia instance with no key yet, for tests that need remote accounts. Its id is its domain. */
export const createInstance = async (ctx: Context, domain: string): Promise<string> => {
    await ctx.db.insertInto("instances")
        .values({
            id: domain,
            domain,
            protocol: "versia",
            public_key: null,
            key_fetched_at: null,
            created_at: ctx.clock.now(),
        })
        .execute();

    return domain;
};

/** The config's defaults for what the routes need, with no issuers. */
export const defaultSettings = (): AboutSettings => ({
    instance: Instance.parse({}),
    limits: Limits.parse({}),
    auth: { issuers: [], dev_login: false },
    media: MediaLimits.parse({}),
});

/** An instance's key pair, with its public half as InstanceMetadata shows it. */
export type KeyPair = { readonly privateKey: CryptoKey; readonly spki: string };

/** A new Ed25519 key pair, with its public half as InstanceMetadata shows it. */
export const keyPair = async (): Promise<KeyPair> => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    if (!("privateKey" in pair)) throw new Error("Ed25519 didn't make a key pair");
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)).toBase64();

    return { privateKey: pair.privateKey, spki };
};

/** Metadata saying an instance is `domain`, with this public key, supporting `extensions`. */
export const metadata = (
    domain: string,
    spki: string,
    algorithm = "ed25519",
    extensions: readonly string[] = [],
): Record<string, unknown> => ({
    type: "InstanceMetadata",
    created_at: "2026-01-01T00:00:00Z",
    name: domain,
    software: { name: "Test", version: "1.0.0" },
    compatibility: { versions: ["0.6.0"], extensions },
    domain,
    public_key: { algorithm, key: spki },
});

/** An instance that answers with its metadata, which says it is `domain`, supporting `extensions`. */
export const metadataServer = (
    domain: string,
    pair: { spki: string },
    extensions: readonly string[] = [],
): Server =>
() => Response.json(metadata(domain, pair.spki, "ed25519", extensions));
