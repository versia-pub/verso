import { z } from "zod";
import { Domain, mediaOf, optional, TransientEntity } from "./common.ts";

/**
 * The Versia versions an instance supports, at `/.well-known/versia`, like `0.7.0`.
 * @see https://versia.pub/federation/endpoints#well-known
 */
export const WellKnown = z.object({
    versions: z.array(z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)),
});
export type WellKnown = z.infer<typeof WellKnown>;

/**
 * What an instance says about itself. `compatibility.extensions` lists each extension with its
 * version, like `pub.versia:likes@1`.
 * @see https://versia.pub/entities/instance-metadata
 */
export const InstanceMetadata = TransientEntity.extend({
    type: z.literal("InstanceMetadata"),
    name: z.string(),
    software: z.object({ name: z.string(), version: z.string() }),
    compatibility: z.object({
        extensions: z.array(z.string().regex(/^[a-z0-9.-]+:[a-z0-9_]+@[1-9][0-9]*$/)),
    }),
    description: optional(z.string()),
    domain: Domain,
    public_key: z.object({
        algorithm: z.literal("ed25519"),
        /** SPKI, in base64. */
        key: z.base64(),
    }),
    logo: optional(mediaOf("image/")),
    banner: optional(mediaOf("image/")),
});
export type InstanceMetadata = z.infer<typeof InstanceMetadata>;
