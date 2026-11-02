/** A preview of a web page, made from what the page says about itself. */
export type PreviewCardsTable = {
    id: string;
    /** The page's address, after redirects and, if the page names one on its own site, canonical. */
    url: string;
    title: string;
    description: string;
    /** An ISO 639-1 code, or `null` if the page doesn't say. */
    language: string | null;
    /** Empty for none. */
    author_name: string;
    author_url: string;
    provider_name: string;
    provider_url: string;
    /** The page's image, stored as local media, or `null` if it has none, or it couldn't be used. */
    image_id: string | null;
    image_description: string;
    published_at: Date | null;
    /** Whether the page says it is an article. */
    link_type: "article" | "unknown";
    /** When the page was fetched. */
    fetched_at: Date;
};

/** The card a status shows: the first page it links to. */
export type NotePreviewCardsTable = {
    note_id: string;
    card_id: string;
    /** The link as the status wrote it, which may differ from the card's `url`. */
    url: string;
};
