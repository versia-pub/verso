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

/**
 * The flag each permission sets in Mastodon's role bitmask, or 0 for none.
 * @see https://docs.joinmastodon.org/entities/Role/#permission-flags
 */
const mastodonFlags: Readonly<Record<Permission, number>> = {
    "read:account": 0,
    "owner:account": 0,
    "roles": 0x20000,
};

/** Mastodon's role bitmask for a set of permissions, as the decimal string clients expect. */
export const mastodonPermissions = (granted: Iterable<Permission>): string => {
    let mask = 0;
    for (const permission of granted) mask |= mastodonFlags[permission];

    return mask.toString();
};
