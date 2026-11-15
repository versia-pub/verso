/**
 * Which version of an entity to keep, by the rule of the entities page: a version whose
 * `updated_at` is older than the held one is discarded, and so is one with another `created_at`.
 * @module
 * @see https://versia.pub/entities
 */

/** The version of an entity that Verso holds. */
export type HeldVersion = {
    readonly createdAt: Date;
    readonly updatedAt: Date | null;
};

/** The version of an entity that arrived, with its times as sent. */
export type ReceivedVersion = {
    readonly created_at: string;
    readonly updated_at?: string | null;
};

/**
 * Whether `received` is discarded for the copy `held`. If either has no `updated_at`, the one
 * received last wins, so it is kept. Times are compared as instants, not as the text sent.
 */
export const isDiscardedVersion = (held: HeldVersion, received: ReceivedVersion): boolean => {
    if (new Date(received.created_at).getTime() !== held.createdAt.getTime()) return true;
    if (!received.updated_at || held.updatedAt === null) return false;

    return new Date(received.updated_at).getTime() < held.updatedAt.getTime();
};
