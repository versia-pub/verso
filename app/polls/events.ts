/**
 * Events about polls for the rest of Verso.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** The poll `pollId` on the status `noteId` ended. */
export type PollEnded = {
    readonly type: "polls.ended";
    readonly pollId: string;
    readonly noteId: string;
};

/** Whether `event` is a {@link PollEnded}. */
export const isPollEnded = (event: DomainEvent): event is PollEnded => event.type === "polls.ended";

/** The votes of `accountId` in the poll `pollId` on the status `noteId` changed. */
export type PollVoted = {
    readonly type: "polls.voted";
    readonly pollId: string;
    readonly noteId: string;
    readonly accountId: string;
};

/** Whether `event` is a {@link PollVoted}. */
export const isPollVoted = (event: DomainEvent): event is PollVoted => event.type === "polls.voted";

/** Votes were counted in the poll `pollId` on the local status `noteId` since it was last sent. */
export type PollUpdated = {
    readonly type: "polls.updated";
    readonly pollId: string;
    readonly noteId: string;
};

/** Whether `event` is a {@link PollUpdated}. */
export const isPollUpdated = (event: DomainEvent): event is PollUpdated =>
    event.type === "polls.updated";
