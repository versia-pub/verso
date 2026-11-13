/**
 * A hashtag's page, `/tags/cats`, with its latest posts, as anyone who isn't logged in sees it.
 * @module
 */
import type { Status } from "@versia/client-api";
import type { Context } from "../kernel/context.ts";
import { isHashtagName } from "../kernel/markup.ts";
import { type Feeds, seenOf } from "../notes/feed_access.ts";
import { renderStatuses } from "../notes/render.ts";
import { hashtagPage, type Origin } from "../notes/timeline_queries.ts";
import { displayNamesOf } from "../tags/tag_queries.ts";
import type { View } from "./page.tsx";
import { StatusEntry } from "./status.tsx";

/** How many of a hashtag's latest posts its page shows. */
const postsShown = 20;

/** Which statuses of `feeds` anyone who isn't logged in may see, if any. */
const anonymousOrigin = async (feeds: Feeds): Promise<Origin | undefined> => {
    const { local, remote } = await seenOf(feeds, undefined);
    return local && remote ? "all" : local ? "local" : remote ? "remote" : undefined;
};

/** The tags that describe the hashtag's page to link previews and search engines. */
const TagHead = (props: { ctx: Context; name: string; url: string }) => {
    const title = `#${props.name}`;

    return (
        <>
            <title>{title}</title>
            <meta name="robots" content="noindex" />
            <meta property="og:site_name" content={props.ctx.urls.domain} />
            <meta property="og:type" content="website" />
            <meta property="og:title" content={title} />
            <meta property="og:url" content={props.url} />
            <meta name="twitter:card" content="summary" />
        </>
    );
};

/**
 * The page of the hashtag `name`, in any case, with its latest posts from where `feeds` lets anyone
 * see them, or nothing if the hashtag isn't known, as on Mastodon.
 */
export const tagView = async (
    ctx: Context,
    feeds: Feeds,
    name: string,
): Promise<View | undefined> => {
    if (!isHashtagName(name)) return undefined;

    const lower = name.toLowerCase();
    const shown = (await displayNamesOf(ctx, [lower])).get(lower);
    if (shown === undefined) return undefined;

    const origin = await anonymousOrigin(feeds);
    const notes = origin === undefined ? [] : await hashtagPage(
        ctx,
        { any: [lower], all: [], none: [] },
        origin,
        null,
        { limit: postsShown },
        false,
    );
    const posts: Status[] = await renderStatuses(ctx, notes, null);

    return {
        head: <TagHead ctx={ctx} name={shown} url={ctx.urls.url`/tags/${lower}`} />,
        body: (
            <>
                <h1>#{shown}</h1>
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
