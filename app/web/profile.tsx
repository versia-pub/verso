/**
 * An account's page, `/@alice` or `/@bob@b.example`, as anyone who isn't logged in sees it, with
 * the OpenGraph tags link previews show.
 * @see https://ogp.me/
 * @module
 */
import { raw } from "@hono/hono/html";
import type { Account, Status } from "@versia/client-api";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import type { AccountRow } from "../accounts/account_queries.ts";
import { publicAccount } from "../accounts/public.ts";
import type { Context } from "../kernel/context.ts";
import { visibilitiesFor } from "../notes/visibility.ts";
import { notePageBy } from "../notes/note_queries.ts";
import { pinnedNotes } from "../notes/pin_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import type { View } from "./page.tsx";
import { StatusEntry } from "./status.tsx";
import { emojify, escape, fullAcct, nameOf, noindex, oneLine, truncate } from "./text.ts";

/** The most of an account's bio a link preview shows, in characters, as on Mastodon. */
const descriptionLength = 160;

/** How many of an account's latest posts its page shows, besides those it pinned. */
const postsShown = 20;

/** The tags that describe the account's page to link previews and search engines. */
const ProfileHead = (props: { ctx: Context; account: Account }) => {
    const { ctx, account } = props;
    const acct = fullAcct(ctx, account);
    const title = `${nameOf(account)} (@${acct})`;
    const description = truncate(oneLine(account.note), descriptionLength);

    return (
        <>
            <title>{title}</title>
            {description && <meta name="description" content={description} />}
            {noindex(account) && <meta name="robots" content="noindex, noarchive" />}
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
    const name = emojify(escape(nameOf(account)), account.emojis);

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
 * The posts anyone may see on the account's page: those it pinned, then its latest that aren't
 * replies to others, boosts included. A suspended account shows none, as on Mastodon.
 */
const postsOf = async (ctx: Context, row: AccountRow): Promise<Status[]> => {
    if (row.suspended_at !== null) return [];

    const visibilities = await visibilitiesFor(ctx, row.id, null);
    const pinned = await pinnedNotes(ctx, row.id, visibilities);
    const latest = await notePageBy(ctx, row.id, visibilities, { excludeReplies: true }, {
        limit: postsShown,
    });
    // Rendering leaves out boosts of statuses anyone may not see.
    return await renderStatuses(ctx, [...pinned, ...latest], null);
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
    const posts = await postsOf(ctx, row);
    return {
        head: <ProfileHead ctx={ctx} account={account} />,
        body: (
            <>
                <Profile ctx={ctx} account={account} />
                {posts.length > 0 && (
                    <section class="posts">
                        {posts.map((status) => (
                            <StatusEntry key={status.id} ctx={ctx} status={status} />
                        ))}
                    </section>
                )}
            </>
        ),
    };
};
