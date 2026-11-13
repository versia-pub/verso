/**
 * The front page, `/`, as anyone who isn't logged in sees it, with the OpenGraph tags link previews
 * show, as on Mastodon.
 * @see https://ogp.me/
 * @module
 */
import type { Status } from "@versia/client-api";
import { banner } from "../accounts/identicon.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { seenOf } from "../notes/feed_access.ts";
import { renderStatuses } from "../notes/render.ts";
import { publicPage } from "../notes/timeline_queries.ts";
import type { View } from "./page.tsx";
import { StatusEntry } from "./status.tsx";

/** How many of the latest local posts the front page shows. */
const postsShown = 20;

export type FrontSettings = Pick<Config, "instance" | "timelines_access" | "permissions">;

/** The tags that describe the front page to link previews and search engines. */
const FrontHead = (props: { ctx: Context; title: string; description: string }) => {
    const { ctx, title, description } = props;

    return (
        <>
            <title>{title}</title>
            {description && <meta name="description" content={description} />}
            <meta property="og:site_name" content={ctx.urls.domain} />
            <meta property="og:type" content="website" />
            <meta property="og:title" content={title} />
            {description && <meta property="og:description" content={description} />}
            <meta property="og:url" content={ctx.urls.url`/`} />
            <meta property="og:image" content={ctx.urls.url`/instance/thumbnail.png`} />
            <meta property="og:image:width" content={String(banner.width)} />
            <meta property="og:image:height" content={String(banner.height)} />
            <meta name="twitter:card" content="summary_large_image" />
        </>
    );
};

/** The latest local public posts, if anyone may see statuses and the local public timeline. */
const latestOf = async (ctx: Context, settings: FrontSettings): Promise<Status[]> => {
    if (!settings.permissions.anonymous.includes("read:note")) return [];
    if (!(await seenOf(settings.timelines_access.live_feeds, undefined)).local) return [];

    const notes = await publicPage(ctx, "local", null, { limit: postsShown });
    return await renderStatuses(ctx, notes, null);
};

/** The front page: the instance's name, description and rules, then its latest local posts. */
export const frontView = async (ctx: Context, settings: FrontSettings): Promise<View> => {
    const { instance } = settings;
    const title = instance.name ?? ctx.urls.domain;
    const posts = await latestOf(ctx, settings);

    return {
        head: <FrontHead ctx={ctx} title={title} description={instance.description} />,
        body: (
            <>
                <h1>{title}</h1>
                {instance.description && <p class="description">{instance.description}</p>}
                {instance.rules.length > 0 && (
                    <ol class="rules">
                        {instance.rules.map((rule) => (
                            <li>
                                {rule.text}
                                {rule.hint && <p class="hint">{rule.hint}</p>}
                            </li>
                        ))}
                    </ol>
                )}
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
