/**
 * Making HTML from remote instances safe to display.
 * @module
 */
import { v0_7 } from "@versia/protocol";
import sanitize from "sanitize-html";

/**
 * The elements of Versia's RichText, except images, video and audio. Anything that loads from
 * elsewhere or acts like part of the page (forms, fonts and colours) is removed: Verso doesn't
 * proxy media embedded in HTML, so loading it would reveal readers' addresses to whoever sent it.
 * `strike` isn't in RichText, but Mastodon's clients show it.
 * @see https://versia.pub/structures/rich-text
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
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "ins",
    "kbd",
    "samp",
    "var",
    "sub",
    "sup",
    "abbr",
    "cite",
    "dfn",
    "q",
    "time",
    "bdi",
    "bdo",
    "wbr",
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

/** The schemes RichText allows in links. */
const linkSchemes = [
    "http",
    "https",
    "mailto",
    "web+versia",
    "dat",
    "dweb",
    "ipfs",
    "ipns",
    "ssb",
    "gopher",
    "xmpp",
    "magnet",
    "gemini",
];

/** A web address that names its host, not one like `http:path` that browsers read as relative. */
const withHost = /^https?:\/\//i;

/** A link's address, if it is a full URL with an allowed scheme. */
const linkAddress = (href: string | undefined) => {
    const protocol = href === undefined ? undefined : URL.parse(href)?.protocol;
    if (protocol === undefined || !linkSchemes.includes(protocol.slice(0, -1))) return undefined;

    return protocol.startsWith("http") && !withHost.test(href ?? "") ? undefined : href;
};

/** An element with its `cite` kept only if it is a full URL with an allowed scheme. */
const withCite = (tagName: string, attribs: sanitize.Attributes) => {
    const { cite, ...rest } = attribs;
    const address = linkAddress(cite);

    return { tagName, attribs: address === undefined ? rest : { ...rest, cite: address } };
};

/**
 * The `a` transform. A mention whose reference is in `mentionHrefs` links to the address it maps
 * to, not to the one the sender gave.
 */
const linkTag =
    (mentionHrefs: ReadonlyMap<string, string> = new Map()) =>
    (tagName: string, attribs: sanitize.Attributes) => {
        const { href: _href, rel: _rel, target: _target, ...rest } = attribs;
        const { "data-mention": mention, ...plain } = rest;
        const mentioned = mention === undefined || !v0_7.ReferenceText.safeParse(mention).success
            ? undefined
            : mention;
        const href = (mentioned && mentionHrefs.get(mentioned)) ?? linkAddress(attribs.href);

        // The link is gone, and its text stays.
        if (href === undefined) return { tagName: "span", attribs: {} };

        const link = { ...linkAttributes, ...plain, href };
        if (mentioned === undefined) return { tagName, attribs: link };

        return { tagName, attribs: { ...link, "data-mention": mentioned, class: "u-url mention" } };
    };

// Raise `sanitizerVersion` whenever these change.
const options: sanitize.IOptions = {
    allowedTags,
    allowedAttributes: {
        "*": ["lang", "dir", "title"],
        a: ["href", "data-mention", "rel", "target"],
        span: ["translate"],
        ol: ["start", "reversed", "type"],
        li: ["value"],
        th: ["colspan", "rowspan", "scope"],
        td: ["colspan", "rowspan"],
        time: ["datetime"],
        del: ["datetime", "cite"],
        ins: ["datetime", "cite"],
        blockquote: ["cite"],
        q: ["cite"],
        details: ["open"],
    },
    allowedClasses: {
        "*": allowedClasses,
        code: [...allowedClasses, "language-*"],
        pre: [...allowedClasses, "language-*"],
    },
    // The library's own check of links and `cite`, though `linkAddress` is stricter.
    allowedSchemes: linkSchemes,
    allowProtocolRelative: false,
    selfClosing: [...sanitize.defaults.selfClosing, "wbr"],
    // Their text means nothing outside them.
    nonTextTags: [
        "script",
        "style",
        "textarea",
        "option",
        "noscript",
        "template",
        "title",
        "iframe",
        "object",
        "embed",
        "svg",
        "math",
    ],
    transformTags: {
        blockquote: withCite,
        q: withCite,
        del: withCite,
        ins: withCite,
        a: linkTag(),
    },
};

/**
 * HTML with only the tags, attributes and classes clients can be trusted with. The text of any
 * other tag is kept, except in scripts, styles and the like.
 *
 * `mentionHrefs` maps references like `example.com:abc` to the address a mention of that reference
 * links to. The map is Verso's own, so its addresses aren't checked again.
 */
export const sanitizeHtml = (
    html: string,
    mentionHrefs?: ReadonlyMap<string, string>,
): string =>
    sanitize(
        html,
        mentionHrefs === undefined
            ? options
            : { ...options, transformTags: { ...options.transformTags, a: linkTag(mentionHrefs) } },
    );

/**
 * Which version of the options remote HTML is sanitised with. Remote HTML is stored sanitised, with
 * the version it was sanitised with, or 0 if it was stored as received.
 */
export const sanitizerVersion = 2;

/**
 * Stored remote HTML as it may be shown: as it is, if sanitised with this version, or else
 * sanitised now. Sanitising again can only remove more, so what a later version allows that an
 * earlier one removed comes back only when the status or profile is fetched again.
 */
export const shownHtml = (html: string, version: number): string =>
    version === sanitizerVersion ? html : sanitizeHtml(html);

/** What `sanitize` writes as entities in text, and the characters they stand for. */
const entities: readonly [string, string][] = [
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    // Last, so `&amp;lt;` stays `&lt;`.
    ["&amp;", "&"],
];

/** Tags that start or end a block of text, or a line, rather than being part of one. */
const blockTag =
    /<(?=\/?(?:p|br|div|li|ul|ol|blockquote|pre|h[1-6]|hr|table|tr|td|th|dl|dt|dd|figure|figcaption)\b)/gi;

/**
 * The text of `html`, as plain text, with a space where each block or line break was, so the text
 * of two paragraphs doesn't run together, but a link's doesn't break apart. Scripts, styles and the
 * like are dropped.
 */
export const textOfHtml = (html: string): string =>
    entities.reduce(
        (text, [entity, character]) => text.replaceAll(entity, character),
        sanitize(html.replaceAll(blockTag, " <"), { allowedTags: [], allowedAttributes: {} }),
    );
