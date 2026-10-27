/**
 * What users write, in plain text or Markdown: the mentions, hashtags and custom emojis in it, and
 * its HTML. Both formats go through one parser, so they find the same things, and never in code or
 * links.
 * @see https://markdown-it.github.io/markdown-it/
 * @module
 */
import markdownIt, { type Env, type MarkdownIt, type StateCore, type Token } from "markdown-it";

export type MarkupFormat = "text/plain" | "text/markdown";

/** A mention as written: `@username`, or `@username@domain` for a remote user. */
export type Mention = { readonly username: string; readonly domain: string | null };

/** What a text mentions, tags and uses, each once, in the order first written. */
export type Found = {
    readonly mentions: readonly Mention[];
    readonly hashtags: readonly string[];
    /** Custom emojis, by shortcode, without the colons. */
    readonly shortcodes: readonly string[];
};

/** Where mentions and hashtags link to. Without a link, they are left as text. */
export type Links = {
    /** The profile of the account a mention is of, if it was found. */
    readonly mention?: (mention: Mention) => string | undefined;
    readonly hashtag?: (tag: string) => string;
};

/** A custom emoji's name, without the colons around it, as Mastodon finds it in text. */
export const shortcodePattern = "[a-zA-Z0-9_]{2,}";

/**
 * Mentions, hashtags and shortcodes, as Mastodon finds them: none straight after a letter or a
 * slash, so addresses and links aren't mistaken for them, and hashtags not all digits.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/account.rb
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/tag.rb
 */
const pattern = new RegExp(
    [
        String.raw`(?<![\p{L}\p{N}_/])@(?<username>[a-z0-9_]+(?:[a-z0-9_.-]*[a-z0-9_])?)` +
        String.raw`(?:@(?<domain>[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+))?`,
        String.raw`(?<![\p{L}\p{M}\p{N}_/)])#(?<tag>[\p{L}\p{M}\p{N}_·‌]*` +
        String.raw`[\p{L}\p{M}_·‌][\p{L}\p{M}\p{N}_·‌]*)`,
        String.raw`(?<![\p{L}\p{N}:]):(?<shortcode>${shortcodePattern}):(?![\p{L}\p{N}:])`,
    ].join("|"),
    "giu",
);

/** What each token the parser added stands for. */
const mentions = new WeakMap<Token, Mention>();
const hashtags = new WeakMap<Token, string>();
const shortcodes = new WeakMap<Token, string>();

/** A text token's mentions, hashtags and shortcodes, split out into tokens of their own. */
const split = (state: StateCore, token: Token): Token[] => {
    const tokens: Token[] = [];
    let from = 0;

    const text = (content: string) => {
        if (content === "") return;
        const piece = new state.Token("text", "", 0);
        piece.content = content;
        tokens.push(piece);
    };

    for (const match of token.content.matchAll(pattern)) {
        const { username, domain, tag, shortcode } = match.groups ?? {};
        text(token.content.slice(from, match.index));
        from = match.index + match[0].length;

        const type = username ? "mention" : tag ? "hashtag" : "shortcode";
        const piece = new state.Token(type, "", 0);
        piece.content = match[0];
        if (username) mentions.set(piece, { username, domain: domain?.toLowerCase() ?? null });
        if (tag) hashtags.set(piece, tag);
        if (shortcode) shortcodes.set(piece, shortcode);
        tokens.push(piece);
    }
    text(token.content.slice(from));

    return tokens;
};

/** Splits the mentions, hashtags and shortcodes out of all the text outside links. */
const social = (state: StateCore) => {
    for (const block of state.tokens) {
        if (block.type !== "inline" || block.children === null) continue;

        let links = 0;
        block.children = block.children.flatMap((token) => {
            if (token.type === "link_open") links++;
            if (token.type === "link_close") links--;

            return token.type === "text" && links === 0 ? split(state, token) : [token];
        });
    }
};

/** Each render's links, by the environment it was given. */
const renders = new WeakMap<object, Links>();

const linksOf = (env: Env | undefined): Links => (env && renders.get(env)) ?? {};

/** What links say about themselves: that they lead away, and vouch for nothing. */
const linkAttributes = { rel: "nofollow noopener noreferrer", target: "_blank" };

const configure = (md: MarkdownIt) => {
    const escape = md.utils.escapeHtml;

    // Only web addresses are links, so not email addresses, as on Mastodon.
    md.validateLink = (url) => /^https?:\/\//i.test(url);
    md.core.ruler.push("social", social);

    md.renderer.rules.link_open = (tokens, idx, options, _env, renderer) => {
        for (const [name, value] of Object.entries(linkAttributes)) {
            tokens[idx].attrSet(name, value);
        }
        return renderer.renderToken(tokens, idx, options);
    };

    md.renderer.rules.mention = (tokens, idx, _options, env) => {
        const token = tokens[idx];
        const mention = mentions.get(token);
        const url = mention && linksOf(env).mention?.(mention);
        if (mention === undefined || url === undefined) return escape(token.content);

        return `<span class="h-card" translate="no"><a href="${escape(url)}" ` +
            `class="u-url mention">@<span>${escape(mention.username)}</span></a></span>`;
    };

    md.renderer.rules.hashtag = (tokens, idx, _options, env) => {
        const token = tokens[idx];
        const tag = hashtags.get(token);
        const url = tag && linksOf(env).hashtag?.(tag);
        if (tag === undefined || url === undefined) return escape(token.content);

        return `<a href="${escape(url)}" class="mention hashtag" rel="tag">` +
            `#<span>${escape(tag)}</span></a>`;
    };

    // Custom emojis are displayed by clients, from the shortcodes in the text.
    md.renderer.rules.shortcode = (tokens, idx) => escape(tokens[idx].content);

    // Paragraphs and line breaks with nothing between them, as Mastodon writes them.
    md.renderer.rules.paragraph_close = (tokens, idx, options, _env, renderer) =>
        renderer.renderToken(tokens, idx, options).trimEnd();
    md.renderer.rules.softbreak = () => "<br>";
    md.renderer.rules.hardbreak = () => "<br>";

    return md;
};

const parsers: Record<MarkupFormat, MarkdownIt> = {
    // Paragraphs, line breaks and links, and nothing else: no escapes or entities.
    "text/plain": configure(
        markdownIt("zero", { breaks: true, linkify: true }).enable(["newline", "linkify"]),
    ),
    // Markdown, but not HTML, which is displayed as written, or images, which would load from
    // wherever the writer chose.
    "text/markdown": configure(
        markdownIt("default", { html: false, breaks: true, linkify: true }).disable("image"),
    ),
};

/** The mentions, hashtags and shortcodes in `text`. */
export const scanText = (text: string, format: MarkupFormat): Found => {
    const found = { mentions: new Map<string, Mention>(), hashtags: new Map<string, string>() };
    const codes = new Set<string>();

    for (const block of parsers[format].parse(text, {})) {
        for (const token of block.children ?? []) {
            const mention = mentions.get(token);
            const key = mention && `${mention.username}@${mention.domain}`.toLowerCase();
            if (mention && key && !found.mentions.has(key)) found.mentions.set(key, mention);

            const tag = hashtags.get(token);
            if (tag && !found.hashtags.has(tag.toLowerCase())) {
                found.hashtags.set(tag.toLowerCase(), tag);
            }

            const shortcode = shortcodes.get(token);
            if (shortcode) codes.add(shortcode);
        }
    }

    return {
        mentions: [...found.mentions.values()],
        hashtags: [...found.hashtags.values()],
        shortcodes: [...codes],
    };
};

/** `text` as HTML, with its mentions and hashtags linked where `links` says. */
export const renderText = (text: string, format: MarkupFormat, links: Links = {}): string => {
    const env = {};
    renders.set(env, links);

    return parsers[format].render(text, env).trim();
};

/** What a link counts as, however long it is. */
export const charactersPerLink = 23;

/**
 * How long `text` is, as Mastodon counts statuses: by what readers see as one character, with each
 * web address counting as {@link charactersPerLink}, and mentions of remote users as just
 * `@username`.
 * @see https://github.com/mastodon/mastodon/blob/main/app/validators/status_length_validator.rb
 */
export const countText = (text: string): number => {
    let counted = "";
    let from = 0;

    for (const link of parsers["text/plain"].linkify.match(text) ?? []) {
        if (!/^https?:$/i.test(link.schema)) continue;

        counted += text.slice(from, link.index) + "x".repeat(charactersPerLink);
        from = link.lastIndex;
    }
    counted += text.slice(from);

    const short = counted.replace(
        pattern,
        (match, username?: string) => username ? `@${username}` : match,
    );

    return [...new Intl.Segmenter().segment(short)].length;
};
