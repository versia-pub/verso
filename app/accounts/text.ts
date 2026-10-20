/**
 * Turns what users write into the HTML that is stored next to it.
 * @module
 */
import { renderText } from "../kernel/markup.ts";

const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** Text with the characters HTML reads specially escaped, for one line, such as a field. */
export const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (char) => escapes[char]);

/**
 * Plain text as HTML: each run of text between blank lines is a paragraph, the other line breaks
 * stay line breaks, and web addresses are links.
 */
export const textToHtml = (text: string): string => renderText(text, "text/plain");
