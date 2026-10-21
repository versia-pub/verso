/**
 * What accounts tell the rest of Verso: profiles changed, and accounts deleted.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** A local account's owner changed its profile. */
export type ProfileUpdated = {
    readonly type: "accounts.profile_updated";
    readonly accountId: string;
    /** Whether it was locked, and no longer is. */
    readonly unlocked: boolean;
};

export const isProfileUpdated = (event: DomainEvent): event is ProfileUpdated =>
    event.type === "accounts.profile_updated";

/**
 * An account is about to be deleted, with everything of other modules' that cascades from it. It
 * is emitted in the transaction that deletes it, while its rows are there to read, so modules can
 * fix what those rows counted on other accounts and notes.
 */
export type AccountDeleting = {
    readonly type: "accounts.deleting";
    readonly accountId: string;
};

export const isAccountDeleting = (event: DomainEvent): event is AccountDeleting =>
    event.type === "accounts.deleting";
