import { z } from "zod";
import { optional, ReferenceText, TransientEntity } from "./common.ts";

/** The key of {@link MigrationExtension} in a User's `extensions`. */
export const migrationKey = "pub.versia:migration";

/**
 * Where a user moved from and to, in its `extensions` under {@link migrationKey}: `previous` on the
 * account it moved to, naming the one it moved from, and `new` on that one once it moved.
 * @see https://versia.pub/extensions/migration
 */
export const MigrationExtension = z.object({
    previous: optional(ReferenceText),
    new: optional(ReferenceText),
});
export type MigrationExtension = z.infer<typeof MigrationExtension>;

/**
 * That the user `author` moved to `destination`, which instances that verify it move the author's
 * followers to.
 * @see https://versia.pub/extensions/migration
 */
export const Migration = TransientEntity.extend({
    type: z.literal("pub.versia:migration/Migration"),
    author: ReferenceText,
    destination: ReferenceText,
});
export type Migration = z.infer<typeof Migration>;
