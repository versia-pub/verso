/**
 * The instance as Mastodon's API describes it, from its config and what it holds.
 * @module
 */
import type {
    ExtendedDescription,
    Instance,
    Rule,
    TermsOfService,
    V1Instance,
} from "@versia/client-api";
import denoConfig from "../../deno.json" with { type: "json" };
import {
    countLocalAccounts,
    countLocalStatuses,
    findLocalAccount,
} from "../accounts/account_queries.ts";
import { publicAccount } from "../accounts/public.ts";
import { escapeHtml, textToHtml } from "../accounts/text.ts";
import { countAccountsWithTokensSince } from "../auth/token_queries.ts";
import { NotFound } from "../http/errors.ts";
import type { Config } from "../kernel/config.ts";
import type { MediaLimits } from "../kernel/config_sections.ts";
import { imageFormats } from "../kernel/images.ts";
import type { Context } from "../kernel/context.ts";
import { permissionNames } from "../kernel/permissions.ts";
import { charactersPerLink } from "../kernel/markup.ts";
import { pinLimit } from "../notes/pins.ts";
import { vapidPublicKey } from "../push/keys.ts";
import { featuredTagLimit } from "../tags/featured_tags.ts";
import { countInstances } from "./instance_queries.ts";

/** What the instance's description is built from. */
export type AboutSettings =
    & Pick<
        Config,
        "instance" | "limits" | "auth" | "streaming" | "search" | "timelines_access" | "permissions"
    >
    & {
        readonly media: MediaLimits;
        readonly federation: Pick<Config["federation"], "blocked_domains">;
    };

/**
 * The Mastodon version clients are told, which they turn features on by. Raise it as Verso
 * implements what later versions added.
 */
const mastodonVersion = "4.7.0";

/** The API version Mastodon 4.7 reports. */
const mastodonApiVersion = 11;

const sourceUrl = "https://github.com/versia-pub/verso";

/** Mastodon's count of active users looks back four weeks. */
const activeWindowMs = 28 * 24 * 60 * 60 * 1000;

/**
 * Why clients can't sign up: accounts are created by logging in with an issuer that lets new people
 * in, if any does.
 */
const registrationMessage = (issuers: AboutSettings["auth"]["issuers"]) => {
    const open = issuers.filter((issuer) => issuer.registration !== "closed")
        .map((issuer) => issuer.name);

    const text = open.length === 0
        ? "This instance isn't taking new accounts."
        : `New accounts are made by logging in with ${
            new Intl.ListFormat("en", { type: "disjunction" }).format(open)
        }.`;

    return `<p>${escapeHtml(text)}</p>`;
};

/** The contact account, if config names a local account that exists. */
const contactAccount = async (ctx: Context, username: string | undefined) => {
    const row = username === undefined ? undefined : await findLocalAccount(ctx, username);
    return row ? await publicAccount(ctx, row) : null;
};

/** The rules, numbered from 1 in the order config lists them. */
export const renderRules = (instance: Pick<AboutSettings["instance"], "rules">): Rule[] =>
    instance.rules.map((rule, index) => ({
        id: String(index + 1),
        text: rule.text,
        hint: rule.hint,
        translations: rule.translations,
    }));

/**
 * What clients may send, limited by the configured limits, where they connect and subscribe to Web
 * Push with, and what logged-out visitors may do.
 */
const configuration = (
    ctx: Context,
    limits: AboutSettings["limits"],
    media: MediaLimits,
    timelines: AboutSettings["timelines_access"],
    permissions: AboutSettings["permissions"],
    vapidKey: string,
): Instance["configuration"] => ({
    urls: { streaming: ctx.urls.origin.replace(/^http/, "ws") },
    vapid: { public_key: vapidKey },
    accounts: {
        max_featured_tags: featuredTagLimit,
        max_pinned_statuses: pinLimit,
        max_display_name_length: limits.display_name,
        max_note_length: limits.note,
        max_avatar_description_length: limits.media_description,
        max_header_description_length: limits.media_description,
        max_profile_fields: limits.fields,
        profile_field_name_limit: limits.field_name,
        profile_field_value_limit: limits.field_value,
    },
    statuses: {
        max_characters: limits.status,
        max_media_attachments: limits.attachments,
        characters_reserved_per_url: charactersPerLink,
    },
    // Any other file is accepted too, as a generic file, but clients offer only what is listed.
    media_attachments: {
        supported_mime_types: Object.values(imageFormats).map((format) => format.mediaType),
        description_limit: limits.media_description,
        image_size_limit: media.max_upload_bytes,
        image_matrix_limit: media.max_pixels,
        video_size_limit: 0,
        video_frame_rate_limit: 0,
        video_matrix_limit: 0,
    },
    polls: {
        max_options: limits.poll_options,
        max_characters_per_option: limits.poll_option,
        min_expiration: limits.poll_min_seconds,
        max_expiration: limits.poll_max_seconds,
    },
    translation: { enabled: false },
    // Mastodon has one setting for hashtag timelines and trending link timelines.
    timelines_access: {
        live_feeds: timelines.live_feeds,
        hashtag_feeds: timelines.topic_feeds,
        trending_link_feeds: timelines.topic_feeds,
    },
    // Verso federates with every instance it hasn't blocked.
    limited_federation: false,
    permissions: { anonymous: permissionNames(permissions.anonymous) },
});

/** How many users, statuses and other instances the instance has, as it tells clients. */
export type InstanceStats = {
    /** Accounts that logged in within `activeWindowMs`. */
    readonly activeMonth: number;
    readonly users: number;
    readonly statuses: number;
    /** Other instances it has stored. */
    readonly domains: number;
};

/** The instance's stats now. They take a few queries, so the routes cache them for a while. */
export const instanceStats = async (ctx: Context): Promise<InstanceStats> => ({
    activeMonth: await countAccountsWithTokensSince(
        ctx,
        new Date(ctx.clock.now().getTime() - activeWindowMs),
    ),
    users: await countLocalAccounts(ctx),
    statuses: await countLocalStatuses(ctx),
    domains: await countInstances(ctx),
});

/** The instance as Mastodon's API describes it. */
export const renderInstance = async (
    ctx: Context,
    settings: AboutSettings,
    stats: InstanceStats,
): Promise<Instance> => {
    const { instance, limits } = settings;
    const domain = ctx.urls.domain;

    return {
        domain,
        title: instance.name ?? domain,
        version: `${mastodonVersion} (compatible; Verso ${denoConfig.version})`,
        source_url: sourceUrl,
        description: instance.description,
        usage: { users: { active_month: stats.activeMonth } },
        thumbnail: {
            url: ctx.urls.url`/instance/thumbnail.png`,
            description: "A pattern generated from the instance's domain name.",
        },
        icon: [],
        languages: [],
        configuration: configuration(
            ctx,
            limits,
            settings.media,
            settings.timelines_access,
            settings.permissions,
            await vapidPublicKey(ctx),
        ),
        // Accounts are created by logging in, never by a client's sign-up form.
        registrations: {
            enabled: false,
            approval_required: false,
            reason_required: false,
            min_age: null,
            message: registrationMessage(settings.auth.issuers),
            url: null,
        },
        api_versions: { mastodon: mastodonApiVersion },
        contact: {
            email: instance.contact.email ?? "",
            account: await contactAccount(ctx, instance.contact.account),
        },
        rules: renderRules(instance),
    };
};

/** The instance as Mastodon described it before 4.0, derived from how it describes itself now. */
export const renderV1Instance = (instance: Instance, stats: InstanceStats): V1Instance => {
    const { description_limit: _, ...media } = instance.configuration.media_attachments;

    return {
        uri: instance.domain,
        title: instance.title,
        short_description: instance.description,
        description: textToHtml(instance.description),
        email: instance.contact.email,
        version: instance.version,
        urls: { streaming_api: instance.configuration.urls.streaming },
        stats: {
            user_count: stats.users,
            status_count: stats.statuses,
            domain_count: stats.domains,
        },
        thumbnail: instance.thumbnail.url,
        languages: instance.languages,
        registrations: instance.registrations.enabled,
        approval_required: instance.registrations.approval_required,
        invites_enabled: false,
        configuration: {
            accounts: { max_featured_tags: instance.configuration.accounts.max_featured_tags },
            statuses: instance.configuration.statuses,
            media_attachments: media,
            polls: instance.configuration.polls,
        },
        contact_account: instance.contact.account,
        rules: instance.rules,
    };
};

type Document = NonNullable<AboutSettings["instance"]["privacy_policy"]>;

/** A configured text, such as the privacy policy, as HTML with the time it changed. */
export const renderDocument = (document: Document | undefined): ExtendedDescription => {
    if (!document) throw new NotFound();

    return { updated_at: document.updated.toISOString(), content: textToHtml(document.text) };
};

/** The terms of service, in force from their date. Only one version is stored. */
export const renderTerms = (ctx: Context, terms: Document | undefined): TermsOfService => {
    if (!terms) throw new NotFound();

    return {
        effective_date: terms.updated.toISOString().slice(0, 10),
        effective: terms.updated <= ctx.clock.now(),
        content: textToHtml(terms.text),
        succeeded_by: null,
    };
};
