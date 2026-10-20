/**
 * What accounts tell the rest of Verso: profiles changed.
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
