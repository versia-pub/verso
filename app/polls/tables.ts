import type { Generated } from "kysely";

/** A poll attached to a status, which asks its question. */
export type PollsTable = {
    id: string;
    note_id: string;
    /** Whether a voter may choose more than one option. */
    multiple: boolean;
    /** Whether the options' votes are hidden until it ends. */
    hide_totals: boolean;
    /** When it ends, or `null` if it never does. */
    expires_at: Date | null;
    /** How many accounts voted, or `null` if unknown. */
    voters_count: number | null;
    created_at: Date;
};

/** One of a poll's options, in order, with its votes. */
export type PollOptionsTable = {
    poll_id: string;
    /** Its index among the poll's options, from 0. */
    position: number;
    title: string;
    votes_count: Generated<number>;
};

/** A local account's vote for one of a poll's options. */
export type PollVotesTable = {
    id: string;
    poll_id: string;
    account_id: string;
    /** The option's position. */
    choice: number;
    created_at: Date;
};
