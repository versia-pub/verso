/**
 * A status that can be found by its words. Postgres keeps the words here, in a `document` tsvector.
 * SQLite keeps them in `note_search_text`, an FTS5 table whose rowid is this row's `id`, since FTS5
 * tables can't reference other tables.
 */
export type NoteSearchTable = {
    note_id: string;
};

/** An account that can be found by the words of its names and domain, kept as `note_search` does. */
export type AccountSearchTable = {
    account_id: string;
};
