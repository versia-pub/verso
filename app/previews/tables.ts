import type { Generated } from "kysely";

/** A preview of a web page, made from what the page says about itself. */
export type PreviewCardsTable = {
    id: string;
    /** The page's address, after redirects, or its canonical one if that is on its own site. */
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
    /** The page's image, stored as local media, or `null` if it has none or it couldn't be used. */
    image_id: string | null;
    image_description: string;
    published_at: Date | null;
    /** Whether the page says it is an article. */
    link_type: "article" | "unknown";
    /** When the page was fetched. */
    fetched_at: Date;
    /** Whether an admin let the card trend, or `null` if they haven't decided. */
    trendable: Generated<boolean | null>;
};

/** Whether the links to a website, and its subdomains, may trend, once an admin decided. */
export type PreviewCardProvidersTable = {
    /** The website's domain name. */
    domain: string;
    trendable: boolean;
};

/** The card a status shows: the first page it links to. */
export type NotePreviewCardsTable = {
    note_id: string;
    card_id: string;
    /** The link as the status wrote it, which may differ from the card's `url`. */
    url: string;
};
