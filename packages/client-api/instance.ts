import { z } from "zod";
import { Account } from "./account.ts";

/**
 * Something people agree to follow on an instance.
 * @see https://docs.joinmastodon.org/entities/Rule/
 */
export const Rule = z.object({
    /** Not always a number. */
    id: z.string(),
    text: z.string(),
    /** More about the rule, or empty. */
    hint: z.string(),
    /** The text and hint in other languages, by language code. Mastodon 4.4 and later. */
    translations: z.record(z.string(), z.object({ text: z.string(), hint: z.string() }))
        .optional(),
});
export type Rule = z.infer<typeof Rule>;

/** Who may read a kind of timeline, without logging in or only once logged in. */
const FeedAccess = z.enum(["public", "authenticated", "disabled"]);

/**
 * An instance, as it describes itself to clients. Fields Mastodon added after 4.3 are optional,
 * since servers claiming an older version leave them out.
 * @see https://docs.joinmastodon.org/entities/Instance/
 */
export const Instance = z.object({
    domain: z.string(),
    title: z.string(),
    /** The Mastodon version the server is compatible with, which clients detect features by. */
    version: z.string(),
    /** Where the server's source code is. */
    source_url: z.url(),
    /** A short paragraph, in plain text. */
    description: z.string(),
    /** The year of the current Wrapstodon, or `null`. Mastodon 4.6 and later. */
    wrapstodon: z.string().nullable().optional(),
    usage: z.object({
        users: z.object({
            /** Local users active in the past four weeks. */
            active_month: z.int().min(0),
        }),
    }),
    thumbnail: z.object({
        url: z.url(),
        /** Mastodon 4.6 and later. */
        description: z.string().optional(),
        blurhash: z.string().optional(),
        versions: z.object({ "@1x": z.url().optional(), "@2x": z.url().optional() }).optional(),
    }),
    /** The instance's icon, in sizes such as `36x36`. */
    icon: z.array(z.object({ src: z.url(), size: z.string() })),
    /** ISO 639-1 codes. */
    languages: z.array(z.string()),
    configuration: z.object({
        urls: z.object({
            /** Where to open the streaming API's WebSocket. */
            streaming: z.url(),
            /** A status page, or `null`. */
            status: z.url().nullable().optional(),
            /** Mastodon 4.4 and later, as are the policies'. */
            about: z.url().optional(),
            privacy_policy: z.url().nullable().optional(),
            terms_of_service: z.url().nullable().optional(),
        }),
        /** For Web Push subscriptions. */
        vapid: z.object({ public_key: z.string() }),
        accounts: z.object({
            max_featured_tags: z.int().min(0),
            max_pinned_statuses: z.int().min(0),
            /** The rest are Mastodon 4.6 and later. */
            max_display_name_length: z.int().min(0).optional(),
            max_note_length: z.int().min(0).optional(),
            max_avatar_description_length: z.int().min(0).optional(),
            max_header_description_length: z.int().min(0).optional(),
            max_profile_fields: z.int().min(0).optional(),
            profile_field_name_limit: z.int().min(0).optional(),
            profile_field_value_limit: z.int().min(0).optional(),
        }),
        statuses: z.object({
            max_characters: z.int().min(0),
            max_media_attachments: z.int().min(0),
            /** How many characters each link counts as, however long. */
            characters_reserved_per_url: z.int().min(0),
        }),
        media_attachments: z.object({
            supported_mime_types: z.array(z.string()),
            /** Mastodon 4.4 and later. */
            description_limit: z.int().min(0).optional(),
            /** In bytes. */
            image_size_limit: z.int().min(0),
            /** Width times height. */
            image_matrix_limit: z.int().min(0),
            video_size_limit: z.int().min(0),
            video_frame_rate_limit: z.int().min(0),
            video_matrix_limit: z.int().min(0),
        }),
        polls: z.object({
            max_options: z.int().min(0),
            max_characters_per_option: z.int().min(0),
            /** In seconds. */
            min_expiration: z.int().min(0),
            max_expiration: z.int().min(0),
        }),
        translation: z.object({ enabled: z.boolean() }),
        /** Mastodon 4.5 and later. */
        timelines_access: z.object({
            live_feeds: z.object({ local: FeedAccess, remote: FeedAccess }),
            hashtag_feeds: z.object({ local: FeedAccess, remote: FeedAccess }),
            trending_link_feeds: z.object({ local: FeedAccess, remote: FeedAccess }),
        }).optional(),
        /** Whether it federates only with instances it allows. Mastodon 4.4 and later. */
        limited_federation: z.boolean().optional(),
    }),
    registrations: z.object({
        /** Whether clients may offer to sign up. */
        enabled: z.boolean(),
        approval_required: z.boolean(),
        /** HTML shown when sign-up is closed, or `null`. */
        message: z.string().nullable(),
        /** Mastodon 4.4 and later, as is `reason_required`. */
        min_age: z.int().min(0).nullable().optional(),
        reason_required: z.boolean().nullable().optional(),
        /** A page elsewhere to sign up on, or `null`. */
        url: z.url().nullable(),
    }),
    /** Which version of Mastodon's API the server speaks, to detect features by. */
    api_versions: z.object({ mastodon: z.int().min(0) }),
    contact: z.object({
        /** Empty if there is none. */
        email: z.string(),
        account: Account.nullable(),
    }),
    rules: z.array(Rule),
});
export type Instance = z.infer<typeof Instance>;
