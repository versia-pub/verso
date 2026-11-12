/**
 * An account's page, `/@alice` or `/@bob@b.example`, as anyone who isn't logged in sees it, with
 * the OpenGraph tags link previews show.
 * @see https://ogp.me/
 * @module
 */
import { raw } from "@hono/hono/html";
import type { Account, CustomEmoji } from "@versia/client-api";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import { publicAccount } from "../accounts/public.ts";
import { shortcodePattern } from "../kernel/markup.ts";
import type { Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import type { View } from "./page.tsx";

/** The most of an account's bio a link preview shows, in characters, as on Mastodon. */
const descriptionLength = 160;

/** `text`, escaped for HTML. */
const escape = (text: string): string =>
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
const fullAcct = (ctx: Context, account: Pick<Account, "acct">): string =>
    account.acct.includes("@") ? account.acct : `${account.acct}@${ctx.urls.domain}`;

/** `text`, cut to `length` characters with an ellipsis if it is longer. */
const truncate = (text: string, length: number): string =>
    text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`;

/** The tags that describe the account's page to link previews and search engines. */
const ProfileHead = (props: { ctx: Context; account: Account }) => {
    const { ctx, account } = props;
    const acct = fullAcct(ctx, account);
    const name = account.display_name || account.username;
    const title = `${name} (@${acct})`;
    const description = truncate(
        textOfHtml(account.note).replace(/\s+/g, " ").trim(),
        descriptionLength,
    );
    // Remote accounts' pages copy their own instance's, and suspended ones aren't indexable.
    const noindex = !account.indexable || account.acct.includes("@");

    return (
        <>
            <title>{title}</title>
            {description && <meta name="description" content={description} />}
            {noindex && <meta name="robots" content="noindex, noarchive" />}
            <link rel="alternate" type="application/vnd.versia+json" href={account.uri} />
            <meta property="og:site_name" content={ctx.urls.domain} />
            <meta property="og:type" content="profile" />
            <meta property="og:title" content={title} />
            {description && <meta property="og:description" content={description} />}
            <meta property="og:url" content={account.url} />
            <meta property="og:image" content={account.avatar_static} />
            <meta property="profile:username" content={acct} />
            <meta name="twitter:card" content="summary" />
        </>
    );
};

/** The account's profile: its pictures, name, bio, fields and counts. */
const Profile = (props: { ctx: Context; account: Account }) => {
    const { ctx, account } = props;
    const name = emojify(escape(account.display_name || account.username), account.emojis);

    return (
        <article class="profile">
            <img class="header" src={account.header_static} alt={account.header_description} />
            <img class="avatar" src={account.avatar_static} alt={account.avatar_description} />
            <h1>{raw(name)}</h1>
            <p class="acct">@{fullAcct(ctx, account)}</p>
            {account.suspended && <p>This account is suspended.</p>}
            {account.moved && (
                <p>
                    Moved to <a href={account.moved.url}>@{fullAcct(ctx, account.moved)}</a>
                </p>
            )}
            <div class="note">{raw(emojify(account.note, account.emojis))}</div>
            {account.fields.length > 0 && (
                <dl class="fields">
                    {account.fields.map((field) => (
                        <>
                            <dt>{raw(emojify(escape(field.name), account.emojis))}</dt>
                            <dd>{raw(emojify(field.value, account.emojis))}</dd>
                        </>
                    ))}
                </dl>
            )}
            <p class="counts">
                {account.statuses_count} posts · {account.following_count} following ·{" "}
                {account.followers_count} followers
            </p>
        </article>
    );
};

/**
 * The page of the account `acct`, such as `@alice` or `@bob@b.example`, or nothing if Verso doesn't
 * know it. A remote account Verso hasn't seen is never fetched, or anyone could make Verso fetch
 * from wherever they liked.
 */
export const profileView = async (ctx: Context, acct: string): Promise<View | undefined> => {
    const address = parseAddress(ctx, acct);
    if (address === undefined) return undefined;

    const row = await findAccountByAddress(ctx, address, { fetch: false });
    if (row === undefined) return undefined;

    const account = await publicAccount(ctx, row);
    return {
        head: <ProfileHead ctx={ctx} account={account} />,
        body: <Profile ctx={ctx} account={account} />,
    };
};
