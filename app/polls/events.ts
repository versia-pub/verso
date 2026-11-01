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
