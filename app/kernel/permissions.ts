import { z } from "zod";

/**
 * What a role may let an account do, named as in Versia Server. `owner:` names cover the account's
 * own things, `read:` names cover viewing, and bare names cover everyone's. Names are only added
 * when a route checks them, since removing one would break configs that list it.
 */
export const permissions = [
    /** View accounts and their profiles. */
    "read:account",
    /** View who accounts follow, and who follows them. */
    "read:account_follows",
    /** View statuses, as their visibility allows. */
    "read:note",
    /** View who likes the statuses one may see. */
    "read:note_likes",
    /** View who boosts the statuses one may see. */
    "read:note_boosts",
    /** View who reacts to the statuses one may see, and with what. */
    "read:reaction",
    /** Change one's own profile and settings. */
    "owner:account",
    /** Follow and unfollow accounts. */
    "owner:follow",
    /** Block and unblock accounts, and see whom one blocks. */
    "owner:block",
    /** Mute and unmute accounts, and see whom one mutes. */
    "owner:mute",
    /** Like statuses, and undo it. */
    "owner:like",
    /** Boost statuses, and undo it. */
    "owner:boost",
    /** React to statuses, and undo it. */
    "owner:reaction",
    /** Post and delete one's own statuses. */
    "owner:note",
    /** Upload media, and describe one's own. */
    "owner:media",
    /** Add one's own custom emojis. */
    "owner:emoji",
    /**
     * See who blocks each account, which is otherwise only the blocker's to know, as moderators may
     * need to.
     */
    "blocks",
    /** Add global custom emojis. */
    "emojis",
    /** Create, change and assign roles below one's own. */
    "roles",
] as const;

export const Permission = z.enum(permissions, { error: "Unknown permission" });
export type Permission = z.infer<typeof Permission>;
