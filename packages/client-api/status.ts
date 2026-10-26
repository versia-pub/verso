import { z } from "zod";
import { Account, ApprovedAudiences, Visibility } from "./account.ts";
import { CustomEmoji } from "./custom_emoji.ts";
import { MediaAttachment } from "./media_attachment.ts";
import { PreviewCard } from "./preview_card.ts";

/**
 * An account a status mentions.
 * @see https://docs.joinmastodon.org/entities/Status/#Mention
 */
export const StatusMention = z.object({
    id: z.string(),
    username: z.string(),
    /** The account's profile page. */
    url: z.url(),
    /** `username` for local accounts, and `username@domain` for remote ones. */
    acct: z.string(),
});
export type StatusMention = z.infer<typeof StatusMention>;

/**
 * The reactions to a status with one emoji. Versia Server's, which Pleroma has as
 * `pleroma.emoji_reactions`.
 * @see https://github.com/versia-pub/server/blob/main/packages/client/schemas/versia.ts
 */
export const StatusReaction = z.object({
    /** A Unicode emoji, or a custom one's shortcode in colons, with its domain if it is remote. */
    name: z.string(),
    count: z.int().min(1),
    /** Whether the emoji is a remote instance's. */
    remote: z.boolean(),
    /** Whether the viewer reacted with it, for a viewer. */
    me: z.boolean().optional(),
});
export type StatusReaction = z.infer<typeof StatusReaction>;

/**
 * A hashtag a status uses.
 * @see https://docs.joinmastodon.org/entities/Status/#Tag
 */
export const StatusTag = z.object({
    /** Without the `#`. */
    name: z.string(),
    /** The hashtag's page. */
    url: z.url(),
});
export type StatusTag = z.infer<typeof StatusTag>;

/**
 * Whether a quote may be displayed. Clients treat states they don't know as `unauthorized`.
 * @see https://docs.joinmastodon.org/entities/Quote/#state
 */
const QuoteState = z.enum([
    "pending",
    "accepted",
    "rejected",
    "revoked",
    "deleted",
    "unauthorized",
    "blocked_account",
    "blocked_domain",
    "muted_account",
]);

/**
 * The status a status quotes, given by id, as it is inside a quote. Mastodon 4.4 and later.
 * @see https://docs.joinmastodon.org/entities/ShallowQuote/
 */
export const ShallowQuote = z.object({
    state: QuoteState,
    /** `null` unless the quote may be displayed. */
    quoted_status_id: z.string().nullable(),
});
export type ShallowQuote = z.infer<typeof ShallowQuote>;

/**
 * Who may quote a status, and whether the viewer may. Mastodon 4.5 and later.
 * @see https://docs.joinmastodon.org/entities/QuoteApproval/
 */
export const QuoteApproval = z.object({
    /** Who may quote it without its author reviewing the quote. */
    automatic: ApprovedAudiences,
    /** Who may quote it once its author reviews the quote. */
    manual: ApprovedAudiences,
    current_user: z.enum(["automatic", "manual", "denied", "unknown"]),
});
export type QuoteApproval = z.infer<typeof QuoteApproval>;

/**
 * A status, local or remote. Fields Mastodon added after 4.3 are optional, since Verso claims 4.3,
 * as are the ones only given to a logged-in viewer.
 * @see https://docs.joinmastodon.org/entities/Status/
 */
export const Status = z.object({
    id: z.string(),
    /** The status's id in the federation protocol. */
    uri: z.url(),
    created_at: z.iso.datetime(),
    account: Account,
    /** HTML. */
    content: z.string(),
    visibility: Visibility,
    sensitive: z.boolean(),
    /** A warning displayed in place of the content until it is opened, or empty for none. */
    spoiler_text: z.string(),
    media_attachments: z.array(MediaAttachment),
    /** What posted it, for statuses posted on the local instance. */
    application: z.object({ name: z.string(), website: z.url().nullable() }).optional(),
    mentions: z.array(StatusMention),
    tags: z.array(StatusTag),
    /** The custom emojis used in the content and warning, and those it has reactions with. */
    emojis: z.array(CustomEmoji),
    /** Reactions to it, by emoji, the first reacted with first. Versia Server's. */
    reactions: z.array(StatusReaction).optional(),
    reblogs_count: z.int().min(0),
    favourites_count: z.int().min(0),
    replies_count: z.int().min(0),
    /** Mastodon 4.5 and later. */
    quotes_count: z.int().min(0).optional(),
    /** The status's web page, or `null` if it has none. */
    url: z.url().nullable(),
    in_reply_to_id: z.string().nullable(),
    in_reply_to_account_id: z.string().nullable(),
    /** The status this one boosts, if it is a boost. */
    get reblog(): z.ZodNullable<typeof Status> {
        return Status.nullable();
    },
    /** Verso has no polls yet. */
    poll: z.null(),
    card: PreviewCard.nullable(),
    /** An ISO 639-1 code, or `null` if unknown. */
    language: z.string().nullable(),
    /** The content as its author wrote it, only returned when the status is deleted. */
    text: z.string().nullable(),
    edited_at: z.iso.datetime().nullable(),
    /** The status this one quotes, or `null` if it quotes none. Mastodon 4.4 and later. */
    get quote(): z.ZodOptional<
        z.ZodNullable<z.ZodUnion<readonly [typeof Quote, typeof ShallowQuote]>>
    > {
        return z.union([Quote, ShallowQuote]).nullable().optional();
    },
    /** Mastodon 4.5 and later. */
    quote_approval: QuoteApproval.optional(),
    favourited: z.boolean().optional(),
    reblogged: z.boolean().optional(),
    /** Whether the viewer muted the status's conversation. */
    muted: z.boolean().optional(),
    bookmarked: z.boolean().optional(),
    /** Present only on the viewer's own statuses that can be pinned. */
    pinned: z.boolean().optional(),
});
export type Status = z.infer<typeof Status>;

/**
 * The status a status quotes, in full. Mastodon 4.4 and later.
 * @see https://docs.joinmastodon.org/entities/Quote/
 */
export const Quote = z.object({
    state: QuoteState,
    /** `null` unless the quote may be displayed. */
    get quoted_status(): z.ZodNullable<typeof Status> {
        return Status.nullable();
    },
});
export type Quote = z.infer<typeof Quote>;

/**
 * The statuses around one in its thread.
 * @see https://docs.joinmastodon.org/entities/Context/
 */
export const Context = z.object({
    /** The statuses it replies to, oldest first. */
    ancestors: z.array(Status),
    /** The replies to it and to them, in thread order. */
    descendants: z.array(Status),
});
export type Context = z.infer<typeof Context>;

/**
 * A status as its author wrote it, for editing it. `content_type` is Pleroma's, for clients that
 * edit Markdown.
 * @see https://docs.joinmastodon.org/entities/StatusSource/
 */
export const StatusSource = z.object({
    id: z.string(),
    text: z.string(),
    spoiler_text: z.string(),
    content_type: z.string().optional(),
});
export type StatusSource = z.infer<typeof StatusSource>;

/**
 * A version of a status, in its edit history. Polls are omitted, as Verso has none.
 * @see https://docs.joinmastodon.org/entities/StatusEdit/
 */
export const StatusEdit = z.object({
    /** HTML. */
    content: z.string(),
    spoiler_text: z.string(),
    sensitive: z.boolean(),
    /** When the status came to say this. */
    created_at: z.iso.datetime(),
    account: Account,
    media_attachments: z.array(MediaAttachment),
    emojis: z.array(CustomEmoji),
});
export type StatusEdit = z.infer<typeof StatusEdit>;
