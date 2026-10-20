import { z } from "zod";
import { Account } from "./account.ts";

/**
 * Who wrote the page a preview card shows.
 * @see https://docs.joinmastodon.org/entities/PreviewCardAuthor/
 */
export const PreviewCardAuthor = z.object({
    name: z.string(),
    url: z.url(),
    /** Their account, or `null` if they have none that is known. */
    account: Account.nullable(),
});
export type PreviewCardAuthor = z.infer<typeof PreviewCardAuthor>;

/**
 * A preview of a link in a status.
 * @see https://docs.joinmastodon.org/entities/PreviewCard/
 */
export const PreviewCard = z.object({
    url: z.url(),
    title: z.string(),
    description: z.string(),
    type: z.enum(["link", "photo", "video", "rich"]),
    authors: z.array(PreviewCardAuthor),
    /** @deprecated Since Mastodon 4.3. Use `authors`. */
    author_name: z.string(),
    /** @deprecated Since Mastodon 4.3. Use `authors`. */
    author_url: z.string(),
    provider_name: z.string(),
    provider_url: z.string(),
    /** HTML to embed a video or photo, or empty. */
    html: z.string(),
    /** Of the embed, or 0 for none. */
    width: z.int().min(0),
    height: z.int().min(0),
    /** A picture for the preview, or `null` if there is none. */
    image: z.url().nullable(),
    /** A video or photo to embed, or empty. */
    embed_url: z.string(),
    /** A placeholder to show while the picture loads, or `null` if there is none. */
    blurhash: z.string().nullable(),
});
export type PreviewCard = z.infer<typeof PreviewCard>;
