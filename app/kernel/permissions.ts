import { z } from "zod";

/**
 * What a role may let an account do, named as in Versia Server. `owner:` names cover the account's
 * own things, `read:` names cover viewing, and bare names cover everyone's. Names are only added
 * when a route checks them, since removing one would break configs that list it.
 */
export const permissions = [
    /** View accounts and their profiles. */
    "read:account",
    /** Change one's own profile and settings. */
    "owner:account",
    /** Create, change and assign roles below one's own. */
    "roles",
] as const;

export const Permission = z.enum(permissions, { error: "Unknown permission" });
export type Permission = z.infer<typeof Permission>;
