/**
 * Text that views show: escaped, with custom emojis, shortened, and accounts' full addresses.
 * @module
 */
import type { Account, CustomEmoji } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import { shortcodePattern } from "../kernel/markup.ts";

/** `text`, escaped for HTML. */
export const escape = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/**
 * `html` with each `:shortcode:` of `emojis` in its text, not in its tags, shown as the emoji's
 * picture.
 */
export const emojify = (html: string, emojis: readonly CustomEmoji[]): string => {
    const byShortcode = new Map(emojis.map((emoji) => [emoji.shortcode, emoji]));
    const shortcode = new RegExp(`:(${shortcodePattern}):`, "g");

    return html.split(/(<[^>]*>)/).map((part, index) =>
        index % 2 === 1 ? part : part.replace(shortcode, (code, name: string) => {
            const emoji = byShortcode.get(name);
            if (!emoji) return code;

            const src = escape(emoji.static_url);
            return `<img class="emoji" src="${src}" alt="${code}" title="${code}">`;
        })
    ).join("");
};

/** The account's address with its domain, such as `alice@a.example`, even for a local one. */
export const fullAcct = (ctx: Context, account: Pick<Account, "acct">): string =>
    account.acct.includes("@") ? account.acct : `${account.acct}@${ctx.urls.domain}`;

/** The name the account shows: its display name, or its username if it has none. */
export const nameOf = (account: Pick<Account, "display_name" | "username">): string =>
    account.display_name || account.username;

/** `text`, cut to `length` characters with an ellipsis if it is longer. */
export const truncate = (text: string, length: number): string =>
    text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;

/** The text of `html` on one line, with each run of spaces and line breaks made one space. */
export const oneLine = (html: string): string => textOfHtml(html).replace(/\s+/g, " ").trim();

/**
 * Whether search engines are told not to index a page of `account`'s: one that isn't indexable, or
 * a remote one, whose pages copy its own instance's.
 */
export const noindex = (account: Pick<Account, "indexable" | "acct">): boolean =>
    !account.indexable || account.acct.includes("@");
