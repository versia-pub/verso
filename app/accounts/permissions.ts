import type { Permission } from "../kernel/permissions.ts";

/**
 * The flag each permission sets in Mastodon's role bitmask, or 0 for none.
 * @see https://docs.joinmastodon.org/entities/Role/#permission-flags
 */
const mastodonFlags: Readonly<Record<Permission, number>> = {
    "read:account": 0,
    "read:account_follows": 0,
    "read:note": 0,
    "read:note_likes": 0,
    "read:note_boosts": 0,
    "read:reaction": 0,
    "owner:account": 0,
    "owner:follow": 0,
    "owner:block": 0,
    "owner:mute": 0,
    "owner:like": 0,
    "owner:boost": 0,
    "owner:reaction": 0,
    "owner:note": 0,
    "owner:media": 0,
    "owner:emoji": 0,
    "read:emoji": 0,
    "search": 0,
    "owner:notification": 0,
    "blocks": 0,
    "emojis": 0x4000,
    "roles": 0x20000,
};

/** Mastodon's role bitmask for a set of permissions, as the decimal string clients expect. */
export const mastodonPermissions = (granted: Iterable<Permission>): string => {
    let mask = 0;
    for (const permission of granted) mask |= mastodonFlags[permission];

    return mask.toString();
};
