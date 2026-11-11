/**
 * Finding the link a status shows a preview card for.
 * @module
 */
import { Parser } from "htmlparser2";

/** Classes of links that mean a person or hashtag rather than a page, as Mastodon writes them. */
const skippedClasses = new Set(["mention", "hashtag", "u-url", "h-card"]);

/**
 * The first link in the status HTML `html` that leads to a web page on another site, as the status
 * wrote it, or `undefined` if there is none. Mentions, hashtags and the links inside a profile card
 * are skipped, and so are addresses on `domain`, which is this instance.
 */
export const firstLink = (html: string, domain: string): string | undefined => {
    let found: string | undefined;
    // How deep inside an element with the class `h-card` the parser is.
    let cardDepth = 0;
    const stack: boolean[] = [];

    const parser = new Parser({
        onopentag: (name, attributes) => {
            const classes = attributes.class?.split(/\s+/) ?? [];
            const card = classes.includes("h-card");
            stack.push(card);
            if (card) cardDepth++;

            if (found !== undefined || name !== "a" || cardDepth > 0) return;
            if (classes.some((each) => skippedClasses.has(each))) return;
            if (attributes.rel?.toLowerCase().split(/\s+/).includes("tag")) return;

            const href = attributes.href?.trim();
            try {
                const url = new URL(href ?? "");
                if (/^https?:$/.test(url.protocol) && url.hostname !== domain) found = href;
            } catch {
                // Not an address.
            }
        },
        onclosetag: () => {
            if (stack.pop()) cardDepth--;
        },
    });
    parser.write(html);
    parser.end();

    return found;
};
