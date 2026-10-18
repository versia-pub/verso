/**
 * Making HTML from other instances safe to show.
 * @module
 */
import sanitize from "sanitize-html";

/**
 * Text formatting, lists, quotes, headings and tables. Anything that loads from elsewhere (pictures,
 * video, audio) or acts like part of the page (forms, fonts and colours) is left out: Verso doesn't
 * proxy remote media, so loading it would show readers' addresses to whoever sent it.
 */
const allowedTags = [
    "a",
    "p",
    "br",
    "span",
    "div",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "del",
    "strike",
    "mark",
    "small",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "details",
    "summary",
    "ruby",
    "rt",
    "rp",
];

/** Microformats, and the classes Mastodon's clients style. */
const allowedClasses = [
    "h-*",
    "p-*",
    "u-*",
    "dt-*",
    "e-*",
    "mention",
    "hashtag",
    "ellipsis",
    "invisible",
];

/** What links say about themselves: that they lead away, and vouch for nothing. */
const linkAttributes = { rel: "nofollow noopener noreferrer", target: "_blank" };

/** A link's address, if it is a full http or https URL, which is the only kind kept. */
const webAddress = (href: string | undefined) => {
    const url = href === undefined ? null : URL.parse(href);
    return url?.protocol === "http:" || url?.protocol === "https:" ? href : undefined;
};

const options: sanitize.IOptions = {
    allowedTags,
    allowedAttributes: {
        a: ["href", "title", "rel", "target"],
        span: ["translate"],
        ol: ["start", "reversed"],
        li: ["value"],
    },
    allowedClasses: { "*": allowedClasses },
    // The library's own check of links, though `webAddress` is stricter.
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    // Their text means nothing outside them.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "title"],
    transformTags: {
        a: (tagName, attribs) => {
            const { href: _href, rel: _rel, target: _target, ...rest } = attribs;
            const href = webAddress(attribs.href);

            return {
                tagName,
                attribs: { ...linkAttributes, ...rest, ...(href === undefined ? {} : { href }) },
            };
        },
    },
};

/**
 * HTML with only the tags, attributes and classes clients can be trusted with, as Mastodon's
 * allow. The text of anything else is kept, except of scripts, styles and the like.
 */
export const sanitizeHtml = (html: string): string => sanitize(html, options);
