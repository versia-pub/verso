/**
 * A local user's direct conversation: the direct statuses of one thread between them and the same
 * other accounts, as Mastodon has them.
 */
export type ConversationsTable = {
    id: string;
    /** Whose conversation it is. */
    account_id: string;
    thread_id: string;
    /** The other accounts in it, as their ids, sorted and joined by spaces. Empty for none. */
    participants: string;
    /**
     * Its latest status, which conversations are ordered and paged by, or `null` once that is
     * deleted, until the next latest is found.
     */
    last_note_id: string | null;
    /** Whether a status someone else posted is in it since the user last read it. */
    unread: boolean;
    created_at: Date;
};

/** A status in a conversation. */
export type ConversationNotesTable = {
    conversation_id: string;
    note_id: string;
};
