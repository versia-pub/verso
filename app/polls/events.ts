/**
 * Events about polls for the rest of Verso.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** A poll ended, as Verso saw, on the status `noteId`. */
export type PollEnded = {
    readonly type: "polls.ended";
    readonly pollId: string;
    readonly noteId: string;
};

export const isPollEnded = (event: DomainEvent): event is PollEnded => event.type === "polls.ended";

/** `accountId` voted in the poll `pollId` on the status `noteId`, as the votes `voteIds`. */
export type PollVoted = {
    readonly type: "polls.voted";
    readonly pollId: string;
    readonly noteId: string;
    readonly accountId: string;
    readonly voteIds: readonly string[];
};

export const isPollVoted = (event: DomainEvent): event is PollVoted => event.type === "polls.voted";
