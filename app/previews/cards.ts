/**
 * Preview cards: a card for the first page a status links to, made by a job that fetches the page,
 * so posting a status doesn't wait on someone else's server. A status keeps its card until its
 * first link changes. A page is fetched again only when a status links to it more than two weeks
 * after the last time.
 * @see https://docs.joinmastodon.org/entities/PreviewCard/
 * @module
 */
import { z } from "zod";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { bytesSource } from "../kernel/files.ts";
import { imageFormatOf } from "../kernel/images.ts";
import { insertUpload } from "../media/upload_queries.ts";
import { keepUsed } from "../media/uploads.ts";
import { isNoteEdited, isNotePosted, isNoteReceived } from "../notes/events.ts";
import { findNote } from "../notes/note_queries.ts";
import { findCard, linkOf, removeLink, saveCard, setLink } from "./card_queries.ts";
import { decodePage, fetchLimited, imageBytes, pageBytes } from "./fetching.ts";
import { firstLink } from "./links.ts";
import { readPage } from "./page.ts";

/** The queue that makes the preview cards of statuses. */
export const cardsQueue = "preview-cards";

const CardJob = z.object({ noteId: z.string() });

/** The box a card's image is scaled down to fit in, as Mastodon does. */
const imageBox = { width: 640, height: 360 };

/** How long a page's card is used before the page is fetched again. */
const staleMs = 14 * 24 * 60 * 60_000;

/** The formats a page's image may be in, as Mastodon accepts. */
const imageFormats = new Set(["jpeg", "png", "gif", "webp"]);

/**
 * Stores the image at `address` as local media, scaled down to fit a card, and returns its id, or
 * `undefined` if it can't be fetched or used.
 */
const storeImage = async (ctx: Context, address: string): Promise<string | undefined> => {
    const fetched = await fetchLimited(ctx, new URL(address), {
        accept: "image/*",
        approves: (type) => type.startsWith("image/"),
        limit: imageBytes,
    });
    if (fetched === undefined || fetched.truncated) return undefined;

    const format = imageFormatOf(fetched.body.subarray(0, 64));
    if (format === undefined || !imageFormats.has(format)) return undefined;

    let result: Awaited<ReturnType<Context["images"]["process"]>>;
    try {
        result = await ctx.images.process(ReadableStream.from([fetched.body]), imageBox);
    } catch {
        return undefined;
    }
    if (!result.ok) return undefined;

    const { image } = result;
    const kept = await bytesSource(image.bytes);
    const preview = await bytesSource(image.preview.bytes);
    await ctx.files.put(kept, image.mediaType);
    await ctx.files.put(preview, image.preview.mediaType);

    const id = ctx.ids();
    await ctx.transaction(async (tx) => {
        await keepUsed(tx, kept, image.mediaType);
        await keepUsed(tx, preview, image.preview.mediaType);

        await insertUpload(tx, {
            id,
            instance_id: null,
            url: null,
            media_type: image.mediaType,
            size: image.bytes.length,
            sha256: kept.sha256,
            width: image.width,
            height: image.height,
            thumbhash: image.thumbhash,
            description: null,
            created_at: tx.clock.now(),
            account_id: null,
            upload_sha256: null,
            processed_at: tx.clock.now(),
            preview_sha256: preview.sha256,
            preview_width: image.preview.width,
            preview_height: image.preview.height,
            blurhash: image.blurhash,
            focus_x: null,
            focus_y: null,
            fit_width: imageBox.width,
            fit_height: imageBox.height,
        });
    });

    return id;
};

/**
 * The id of the card for `link`: the one Verso has if it is recent enough, otherwise one made from
 * the page. Resolves with `undefined` if the page can't be fetched or has no title and there was
 * no card before.
 */
const cardFor = async (ctx: Context, link: string): Promise<string | undefined> => {
    const url = new URL(link);
    const before = await findCard(ctx, url.href);
    const now = ctx.clock.now();
    if (before && now.getTime() - before.fetched_at.getTime() < staleMs) return before.id;

    const fetched = await fetchLimited(ctx, url, {
        accept: "text/html",
        approves: (type) => type === "text/html",
        limit: pageBytes,
    });
    const details = fetched && readPage(decodePage(fetched), fetched.url);
    if (fetched === undefined || details === undefined) return before?.id;

    const imageId = details.imageUrl ? await storeImage(ctx, details.imageUrl) : undefined;

    return await saveCard(ctx, {
        id: ctx.ids(),
        url: details.canonicalUrl ?? fetched.url.href,
        title: details.title,
        description: details.description,
        language: details.language,
        author_name: details.authorName,
        author_url: details.authorUrl,
        provider_name: details.providerName,
        provider_url: details.providerUrl,
        image_id: imageId ?? null,
        image_description: details.imageDescription,
        published_at: details.publishedAt,
        link_type: details.linkType,
        fetched_at: now,
    });
};

/**
 * Makes the card of the status in the job: its first link's, or none if it has no link or the page
 * gives no title. It does nothing if the status already shows the card of that link.
 */
export const cardHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = CardJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a card job");

    const note = await findNote(ctx, payload.data.noteId);
    if (note === undefined || note.reblog_of_id !== null) return;

    const link = firstLink(note.content_html, ctx.urls.domain);
    const before = await linkOf(ctx, note.id);
    if (link === before?.url) return;

    const card = link === undefined ? undefined : await cardFor(ctx, link);
    await ctx.transaction(async (tx) => {
        // The status may have been deleted while the page was fetched.
        if (link === undefined || card === undefined || await findNote(tx, note.id) === undefined) {
            return await removeLink(tx, note.id);
        }

        await setLink(tx, note.id, card, link);
    });
};

/**
 * Queues a job to make the card of the status `noteId`, if the first link in its text isn't the one
 * its card is for. A remote status waits up to a minute, as Mastodon does, so a status that
 * thousands of servers fetch doesn't make them all fetch the page at once.
 */
const queueCard = async (ctx: Context, noteId: string, remote: boolean): Promise<void> => {
    const note = await findNote(ctx, noteId);
    if (note === undefined || note.reblog_of_id !== null) return;

    const link = firstLink(note.content_html, ctx.urls.domain);
    if (link === (await linkOf(ctx, note.id))?.url) return;

    const payload: z.infer<typeof CardJob> = { noteId };
    await enqueue(ctx, {
        queue: cardsQueue,
        payload,
        runAt: remote
            ? new Date(ctx.clock.now().getTime() + (1 + Math.random() * 58) * 1000)
            : undefined,
        maxAttempts: 1,
        dedupeKey: `card:${noteId}`,
    });
};

/** Queues the card of each status that is posted, edited or received. */
export const queueCards = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event) || isNoteEdited(event)) {
        return await queueCard(ctx, event.noteId, false);
    }
    if (isNoteReceived(event)) return await queueCard(ctx, event.noteId, true);
};
