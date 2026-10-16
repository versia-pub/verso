/**
 * Turns what users write into the HTML that is stored next to it.
 * @module
 */

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
 * Plain text as HTML: each run of text between blank lines is a paragraph, and the other line
 * breaks stay line breaks.
 */
export const textToHtml = (text: string): string =>
    text.replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "")
        .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
        .join("");
