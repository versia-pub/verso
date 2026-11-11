import { z } from "zod";
import { Account } from "./account.ts";

/**
 * Where the viewer's account moved from, as Verso's migration methods show it. Verso's own, as
 * Mastodon has no such methods, and Versia only names a single account a user moved from.
 * @see https://versia.pub/extensions/migration
 */
export const AccountMigration = z.object({
    /** The account the viewer says they moved from, which may then move to theirs. */
    previous: Account.nullable(),
});
export type AccountMigration = z.infer<typeof AccountMigration>;
