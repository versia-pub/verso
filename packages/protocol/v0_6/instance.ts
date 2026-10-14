import { z } from "zod";
import { contentFormatOf, optional, TransientEntity } from "./common.ts";

const Image = contentFormatOf("image/");

/** https://versia.pub/entities/instance-metadata */
export const InstanceMetadata = TransientEntity.extend({
  type: z.literal("InstanceMetadata"),
  name: z.string(),
  software: z.object({ name: z.string(), version: z.string() }),
  compatibility: z.object({
    versions: z.array(z.string()),
    extensions: z.array(z.string()),
  }),
  description: optional(z.string()),
  /** A hostname without a port. https://versia.pub/api/basics#domain */
  domain: z.hostname(),
  public_key: z.object({
    algorithm: z.literal("ed25519"),
    /** SPKI, in base64. */
    key: z.base64(),
  }),
  logo: optional(Image),
  banner: optional(Image),
});
export type InstanceMetadata = z.infer<typeof InstanceMetadata>;
