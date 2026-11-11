/**
 * Reading what a web page says about itself, for its preview card: the title, description, image,
 * site and author it gives in JSON-LD, Open Graph and ordinary meta tags, in that order of
 * preference, as Mastodon does.
 * @see https://ogp.me/
 * @see https://schema.org/Article
 * @module
 */
import { Parser } from "htmlparser2";

/** What a page says about itself. */
export type PageDetails = {
    readonly title: string;
    readonly description: string;
    /** Where the page's image is, as an absolute web address, or `null` if it has none. */
    readonly imageUrl: string | null;
    readonly imageDescription: string;
    readonly providerName: string;
    readonly providerUrl: string;
    readonly authorName: string;
    readonly authorUrl: string;
    /** An ISO 639-1 code, or `null` if the page doesn't say. */
    readonly language: string | null;
    readonly publishedAt: Date | null;
    /** The page's own address for itself, if it is on the same host as the page. */
    readonly canonicalUrl: string | null;
    readonly linkType: "article" | "unknown";
};

/** How long each field is kept, so a page can't fill the database with one. */
const limits = { title: 300, description: 1000, name: 200, url: 2000 };

const clip = (text: string, length: number) => [...text].slice(0, length).join("");

/** `text` with runs of whitespace as single spaces, and no whitespace at the ends. */
const tidy = (text: string, length: number) => clip(text.replace(/\s+/g, " ").trim(), length);

/** `value` as an absolute web address, resolved against `base`, or `undefined` if it isn't one. */
const webAddress = (value: string | undefined, base: URL): string | undefined => {
    if (!value?.trim()) return undefined;

    try {
        const url = new URL(value.trim(), base);
        return /^https?:$/.test(url.protocol) && url.href.length <= limits.url
            ? url.href
            : undefined;
    } catch {
        return undefined;
    }
};

type Tags = {
    meta: Map<string, string>;
    canonical?: string;
    lang?: string;
    title: string;
    ld: string[];
};

/** The first value of each meta tag by name or property, the `<title>`, and JSON-LD blocks. */
const scan = (html: string): Tags => {
    const tags: Tags = { meta: new Map(), title: "", ld: [] };
    let inTitle = false;
    let ld: string | undefined;
    let seenTitle = false;

    const parser = new Parser({
        onopentag: (name, attributes) => {
            if (name === "html") tags.lang ??= attributes.lang;
            else if (name === "title" && !seenTitle) inTitle = true;
            else if (name === "meta") {
                const key = (attributes.property ?? attributes.name)?.toLowerCase();
                if (key && attributes.content !== undefined && !tags.meta.has(key)) {
                    tags.meta.set(key, attributes.content);
                }
            } else if (name === "link") {
                if (attributes.rel?.toLowerCase().split(/\s+/).includes("canonical")) {
                    tags.canonical ??= attributes.href;
                }
            } else if (name === "script") {
                if (attributes.type?.toLowerCase() === "application/ld+json") ld = "";
            }
        },
        ontext: (text) => {
            if (inTitle) tags.title += text;
            else if (ld !== undefined) ld += text;
        },
        onclosetag: (name) => {
            if (name === "title") {
                inTitle = false;
                seenTitle = true;
            } else if (name === "script" && ld !== undefined) {
                tags.ld.push(ld);
                ld = undefined;
            }
        },
    });
    parser.write(html);
    parser.end();

    return tags;
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown) => typeof value === "string" ? value : undefined;

/** `value`, or the first of its items if it is a list. */
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;

/** A name that JSON-LD gives as a string, or as an object or list of them with a `name`. */
const nameOf = (value: unknown): string | undefined => {
    const one = first(value);
    return isObject(one) ? textOf(one.name) : textOf(one);
};

const addressOf = (value: unknown): string | undefined => {
    const one = first(value);
    return isObject(one) ? textOf(one.url) : undefined;
};

/** The first article or web page that the JSON-LD blocks describe. */
const described = (blocks: readonly string[]): Json | undefined => {
    for (const block of blocks) {
        let data: unknown;
        try {
            data = JSON.parse(block);
        } catch {
            continue;
        }

        const items = [data].flat().flatMap((item) =>
            isObject(item) && Array.isArray(item["@graph"]) ? item["@graph"] : [item]
        );
        const found = items.find((item): item is Json =>
            isObject(item) &&
            [item["@type"]].flat().some((type) => type === "NewsArticle" || type === "WebPage")
        );
        if (found) return found;
    }

    return undefined;
};

/** A language code, such as `en-GB`, as its ISO 639-1 language, or `null` if it isn't one. */
const languageOf = (code: string | undefined): string | null => {
    try {
        const [language] = Intl.getCanonicalLocales(code?.trim().replace(/_/g, "-") ?? "")[0]
            ?.split("-") ?? [];
        return language?.length === 2 ? language : null;
    } catch {
        return null;
    }
};

const dateOf = (value: string | undefined): Date | null => {
    const date = value ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : null;
};

/**
 * What the page `html`, which is at `url`, says about itself, or `undefined` if it gives no title.
 */
export const readPage = (html: string, url: URL): PageDetails | undefined => {
    const tags = scan(html);
    const data = described(tags.ld);
    const meta = (key: string) => tags.meta.get(key);

    const title = tidy(
        textOf(data?.headline) || meta("og:title") || tags.title,
        limits.title,
    );
    if (title === "") return undefined;

    const image = webAddress(meta("og:image") ?? meta("og:image:url"), url) ?? null;
    const site = meta("og:site")?.trim();
    const providerUrl = site &&
        webAddress(/^[a-z][a-z\d+.-]*:/i.test(site) ? site : `https://${site}`, url);
    const canonical = webAddress(tags.canonical ?? meta("og:url"), url);
    const author = first(data?.author);
    const type = [data?.["@type"]].flat();

    return {
        title,
        description: tidy(
            textOf(data?.description) || meta("og:description") || meta("description") || "",
            limits.description,
        ),
        imageUrl: image,
        imageDescription: image ? tidy(meta("og:image:alt") ?? "", limits.description) : "",
        providerName: tidy(
            nameOf(data?.publisher) || meta("og:site_name") || "",
            limits.name,
        ),
        providerUrl: providerUrl ?? "",
        authorName: tidy(
            nameOf(author) || meta("og:author") || meta("og:author:username") || "",
            limits.name,
        ),
        authorUrl: webAddress(addressOf(author), url) ?? "",
        language: languageOf(textOf(data?.inLanguage) || meta("og:locale") || tags.lang),
        publishedAt: dateOf(textOf(data?.datePublished) || meta("article:published_time")),
        canonicalUrl: canonical && new URL(canonical).host === url.host ? canonical : null,
        linkType: type.includes("NewsArticle") || meta("og:type") === "article"
            ? "article"
            : "unknown",
    };
};
