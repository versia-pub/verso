/** Where a filter applies, as Mastodon names them. `home` covers lists too. */
export const filterContexts = ["home", "notifications", "public", "thread", "account"] as const;

export type FilterContext = typeof filterContexts[number];

/** What is done with a status a filter matches: shown behind a warning, or left out. */
export const filterActions = ["warn", "hide"] as const;

export type FilterAction = typeof filterActions[number];

/** A filter of a local user's, which matches statuses by keywords or by id. */
export type FiltersTable = {
    id: string;
    /** Whose filter it is. */
    account_id: string;
    title: string;
    /** Where it applies, in the order the user gave them. */
    context: FilterContext[];
    action: FilterAction;
    /** When it stops applying, or `null` if it never does. */
    expires_at: Date | null;
    created_at: Date;
};

/** A keyword a filter matches statuses by. */
export type FilterKeywordsTable = {
    id: string;
    filter_id: string;
    keyword: string;
    /** Whether it matches only at word boundaries. */
    whole_word: boolean;
    created_at: Date;
};

/** A status a filter matches. */
export type FilterStatusesTable = {
    id: string;
    filter_id: string;
    note_id: string;
    created_at: Date;
};
