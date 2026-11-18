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
    /** When Verso saw it had ended and told its voters, or `null` if it hasn't yet. */
    ended_at: Generated<Date | null>;
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

/** An account's vote for one of a poll's options. */
export type PollVotesTable = {
    id: string;
    poll_id: string;
    account_id: string;
    /** The option's position. */
    choice: number;
    created_at: Date;
};

/** An account's ballot in a poll: all its votes, which Versia sends as one Vote. */
export type PollBallotsTable = {
    /** The Vote's id, as Verso sends it for a local voter. */
    id: string;
    poll_id: string;
    account_id: string;
    /** The Vote's id on the voter's instance, or `null` for a local voter. */
    remote_id: string | null;
    created_at: Date;
    /** For a local voter, when choices were last added. For a remote one, as received. */
    updated_at: Date | null;
};
