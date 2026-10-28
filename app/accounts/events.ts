/**
 * Events about accounts for the rest of Verso: accounts created or received, profiles changed, and
 * accounts deleted.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** A local account was created. */
export type AccountCreated = {
    readonly type: "accounts.created";
    readonly accountId: string;
};

export const isAccountCreated = (event: DomainEvent): event is AccountCreated =>
    event.type === "accounts.created";

/**
 * A remote account was saved, new or changed. It has its own type, so that what reacts to local
 * users' profiles, such as sending them, never sees it.
 */
export type AccountReceived = {
    readonly type: "accounts.received";
    readonly accountId: string;
};

export const isAccountReceived = (event: DomainEvent): event is AccountReceived =>
    event.type === "accounts.received";

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
 * An account is about to be deleted, along with everything in other modules that cascades from it.
 * It is emitted in the transaction that deletes it, while its rows still exist, so modules can fix
 * the counts those rows contributed to other accounts and statuses.
 */
export type AccountDeleting = {
    readonly type: "accounts.deleting";
    readonly accountId: string;
};

export const isAccountDeleting = (event: DomainEvent): event is AccountDeleting =>
    event.type === "accounts.deleting";
