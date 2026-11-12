/**
 * A status's page, `/@alice/:id` or `/@bob@b.example/:id`, with its thread, as anyone who isn't
 * logged in sees it, with the OpenGraph tags link previews show, as on Mastodon.
 * @see https://ogp.me/
 * @module
 */
import { raw } from "@hono/hono/html";
import type { HtmlEscapedString } from "@hono/hono/utils/html";
import type { MediaAttachment, Status } from "@versia/client-api";
import { findAccountByAddress, parseAddress } from "../accounts/addresses.ts";
import type { Context } from "../kernel/context.ts";
import { renderStatuses } from "../notes/render.ts";
import { threadOf } from "../notes/threads.ts";
import { visibleNote } from "../notes/visibility.ts";
import type { View } from "./page.tsx";
import { emojify, escape, fullAcct, nameOf, noindex, oneLine, truncate } from "./text.ts";

/** The most of a status's text or content warning a page's title shows, in characters. */
const quoteLength = 50;

/** `count` of `noun`, which is `plural` if there are several, such as "2 images". */
const counted = (count: number, noun: string, plural = `${noun}s`) =>
    `${count} ${count === 1 ? noun : plural}`;

/**
 * What media is attached, such as "Attached: 2 images · 1 video", or nothing if there is none. Any
 * media that is neither video nor audio counts as an image, as on Mastodon.
 */
const mediaSummary = (attachments: readonly MediaAttachment[]): string => {
    const videos = attachments.filter((each) => each.type === "video").length;
    const audios = attachments.filter((each) => each.type === "audio").length;
    const images = attachments.length - videos - audios;
    const counts = [
        images > 0 ? counted(images, "image") : "",
        videos > 0 ? counted(videos, "video") : "",
        audios > 0 ? counted(audios, "audio", "audio") : "",
    ].filter(Boolean);

    return counts.length === 0 ? "" : `Attached: ${counts.join(" · ")}`;
};

/**
 * What a link preview says of `status`: what media it has and its content warning, or if it has
 * none, its text and its poll's options, as on Mastodon.
 */
export const statusDescription = (status: Status): string => {
    const warning = status.spoiler_text && `Content warning: ${status.spoiler_text}`;
    const parts = [[mediaSummary(status.media_attachments), warning].filter(Boolean).join(" · ")];
    if (!status.spoiler_text) {
        parts.push(oneLine(status.content));
        if (status.poll) {
            parts.push(status.poll.options.map((each) => `[ ] ${each.title}`).join("\n"));
        }
    }

    return parts.filter(Boolean).join("\n\n");
};

/** The pictures a link preview may show of `status`'s media: none if it is sensitive. */
export const previewImages = (
    status: Status,
): { url: string; size?: { width?: number; height?: number }; alt: string | null }[] =>
    status.sensitive ? [] : status.media_attachments.flatMap((attachment) => {
        const picture = attachment.type === "image" ? attachment.url : attachment.preview_url;
        if (attachment.type === "audio" || attachment.type === "unknown" || !picture) return [];

        const size = attachment.type === "image"
            ? attachment.meta?.original
            : attachment.meta?.small;
        return [{ url: picture, size, alt: attachment.description }];
    });

/** The tags that describe the status's page to link previews and search engines. */
const StatusHead = (props: { ctx: Context; status: Status }) => {
    const { ctx, status } = props;
    const { account } = status;
    const quote = truncate(status.spoiler_text || oneLine(status.content), quoteLength);
    const description = statusDescription(status);
    const images = previewImages(status);

    return (
        <>
            <title>{`${nameOf(account)}: "${quote}"`}</title>
            {description && <meta name="description" content={description} />}
            {noindex(account) && <meta name="robots" content="noindex, noarchive" />}
            <link rel="alternate" type="application/vnd.versia+json" href={status.uri} />
            <meta property="og:site_name" content={ctx.urls.domain} />
            <meta property="og:type" content="article" />
            <meta property="og:title" content={`${nameOf(account)} (@${fullAcct(ctx, account)})`} />
            {description && <meta property="og:description" content={description} />}
            <meta property="og:url" content={status.url} />
            <meta property="og:published_time" content={status.created_at} />
            {status.language && <meta property="og:locale" content={status.language} />}
            <meta property="profile:username" content={fullAcct(ctx, account)} />
            {images.map((image) => (
                <>
                    <meta property="og:image" content={image.url} />
                    {image.size?.width && (
                        <meta property="og:image:width" content={String(image.size.width)} />
                    )}
                    {image.size?.height && (
                        <meta property="og:image:height" content={String(image.size.height)} />
                    )}
                    {image.alt && <meta property="og:image:alt" content={image.alt} />}
                </>
            ))}
            <meta
                name="twitter:card"
                content={images.length > 0 ? "summary_large_image" : "summary"}
            />
        </>
    );
};

/**
 * The status's media: pictures, and previews of videos, each linking to the media, and links to
 * the rest. Videos and audio aren't played here, as views may not load them.
 */
const Media = (props: { attachments: readonly MediaAttachment[] }) => (
    <div class="media">
        {props.attachments.map((attachment) => {
            const href = attachment.url ?? attachment.remote_url ?? undefined;
            const alt = attachment.description ?? "";
            const picture = attachment.type === "image"
                ? attachment.preview_url ?? attachment.url
                : attachment.preview_url;

            return (
                <a href={href}>
                    {picture ? <img src={picture} alt={alt} /> : alt || attachment.type}
                </a>
            );
        })}
    </div>
);

/** What the status says: its text, media and poll. */
const Content = (props: { status: Status }) => {
    const { status } = props;
    const media = status.media_attachments.length > 0 && (
        status.sensitive && !status.spoiler_text
            ? (
                <details>
                    <summary>Sensitive media</summary>
                    <Media attachments={status.media_attachments} />
                </details>
            )
            : <Media attachments={status.media_attachments} />
    );

    return (
        <>
            <div class="content">{raw(emojify(status.content, status.emojis))}</div>
            {media}
            {status.poll && (
                <ul class="poll">
                    {status.poll.options.map((option) => (
                        <li>
                            {raw(emojify(escape(option.title), status.poll?.emojis ?? []))}
                            {option.votes_count !== null &&
                                ` · ${counted(option.votes_count, "vote")}`}
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
};

/** A status: who posted it and when, and what it says, behind its content warning if it has one. */
export const StatusCard = (
    props: { ctx: Context; status: Status; focus?: boolean },
): HtmlEscapedString | Promise<HtmlEscapedString> => {
    const { ctx, status } = props;
    const { account } = status;

    return (
        <article class={props.focus ? "status focus" : "status"}>
            <header>
                <a href={account.url}>
                    <img class="avatar" src={account.avatar_static} alt="" />{" "}
                    <b>{raw(emojify(escape(nameOf(account)), account.emojis))}</b>{" "}
                    @{fullAcct(ctx, account)}
                </a>{" "}
                ·{" "}
                <a href={status.url}>
                    <time datetime={status.created_at}>
                        {status.created_at.slice(0, 16).replace("T", " ")} UTC
                    </time>
                </a>
            </header>
            {status.spoiler_text
                ? (
                    <details>
                        <summary>
                            {raw(emojify(escape(status.spoiler_text), status.emojis))}
                        </summary>
                        <Content status={status} />
                    </details>
                )
                : <Content status={status} />}
        </article>
    );
};

/** A status as a list of them shows it: a boost says who boosted it above the status it boosts. */
export const StatusEntry = (
    props: { ctx: Context; status: Status },
): HtmlEscapedString | Promise<HtmlEscapedString> => {
    const { ctx, status } = props;
    if (!status.reblog) return <StatusCard ctx={ctx} status={status} />;

    const booster = status.account;
    return (
        <div class="boost">
            <p class="boosted">
                <a href={booster.url}>{raw(emojify(escape(nameOf(booster)), booster.emojis))}</a>
                {" "}
                boosted
            </p>
            <StatusCard ctx={ctx} status={status.reblog} />
        </div>
    );
};

/**
 * The page of the status `id` by the account `acct`, such as `@alice` or `@bob@b.example`, with the
 * statuses it replies to above it and the replies to it below, or nothing if anyone may not see it
 * there. A boost has no page, as on Mastodon. Nothing is fetched from remote instances.
 */
export const statusView = async (
    ctx: Context,
    acct: string,
    id: string,
): Promise<View | undefined> => {
    const address = parseAddress(ctx, acct);
    if (address === undefined) return undefined;

    const author = await findAccountByAddress(ctx, address, { fetch: false });
    if (author === undefined) return undefined;

    const note = await visibleNote(ctx, id, null);
    if (note === undefined || note.account_id !== author.id || note.reblog_of_id !== null) {
        return undefined;
    }

    const thread = await threadOf(ctx, note, null);
    const shown = await renderStatuses(
        ctx,
        [...thread.ancestors, note, ...thread.descendants],
        null,
    );
    const ancestors = shown.slice(0, thread.ancestors.length);
    const status = shown[thread.ancestors.length];
    const descendants = shown.slice(thread.ancestors.length + 1);
    if (status === undefined) return undefined;

    return {
        head: <StatusHead ctx={ctx} status={status} />,
        body: (
            <section class="thread">
                {ancestors.map((each) => <StatusCard key={each.id} ctx={ctx} status={each} />)}
                <StatusCard ctx={ctx} status={status} focus />
                {descendants.map((each) => <StatusCard key={each.id} ctx={ctx} status={each} />)}
            </section>
        ),
    };
};
