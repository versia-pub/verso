import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import type { PollEnded } from "./events.ts";
import { markEndedPolls } from "./poll_queries.ts";

/** The queue whose job, every minute, finds the polls that have ended. */
export const endedPollsQueue = "polls-ended";

/** How many polls a transaction marks as ended. */
const perTransaction = 100;

/** Marks the polls that have ended since the last run, and emits that each ended. */
export const endPolls = async (ctx: Context): Promise<void> => {
    let marked: number;

    do {
        marked = await ctx.transaction(async (tx) => {
            const polls = await markEndedPolls(tx, perTransaction);

            for (const poll of polls) {
                const event: PollEnded = {
                    type: "polls.ended",
                    pollId: poll.id,
                    noteId: poll.note_id,
                };
                await emit(tx, event);
            }

            return polls.length;
        });
    } while (marked === perTransaction);
};
