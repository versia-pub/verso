/**
 * The words of `text` as search finds them: runs of letters and digits, in lower case and without
 * accents, so "Café" is found as "cafe". Verso does this itself, rather than each database, so that
 * Postgres and SQLite find the same things, and words never carry a database's query syntax.
 */
export const searchWords = (text: string): string[] =>
    text.normalize("NFKD")
        .replaceAll(/\p{M}/gu, "")
        // Puts back together what the decomposition split but are letters of their own, like Hangul.
        .normalize("NFC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
