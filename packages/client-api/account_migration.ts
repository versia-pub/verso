import { z } from "zod";
import { Account } from "./account.ts";

/**
 * Where the viewer's account moved from, and to. Verso's own: Mastodon has no such methods, and
 * Versia only names a single account a user moved from.
 * @see https://versia.pub/extensions/migration
 */
export const AccountMigration = z.object({
    /** The account the viewer says they moved from, which may then move to theirs. */
    previous: Account.nullable(),
    /** The account the viewer moved to, whose followers then follow it instead. */
    moved: Account.nullable(),
});
export type AccountMigration = z.infer<typeof AccountMigration>;
