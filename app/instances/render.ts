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
import { charactersPerLink } from "../kernel/markup.ts";
import { countInstances } from "./instance_queries.ts";

/** What the instance's description is made from. */
export type AboutSettings = Pick<Config, "instance" | "limits" | "auth"> & {
    readonly media: MediaLimits;
};

/**
 * The Mastodon version clients are told, which they turn features on by. Raise it as Verso does
 * what later versions added.
 */
const mastodonVersion = "4.3.0";

/** The API version Mastodon 4.3 reports. */
const mastodonApiVersion = 2;

const sourceUrl = "https://github.com/versia-pub/verso";

/** Mastodon's count of active users looks back four weeks. */
const activeWindowMs = 28 * 24 * 60 * 60 * 1000;

/**
 * Why clients can't sign up: accounts are made by logging in with an issuer that lets new people
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
export const renderRules = (instance: AboutSettings["instance"]): Rule[] =>
    instance.rules.map((rule, index) => ({
        id: String(index + 1),
        text: rule.text,
        hint: rule.hint,
    }));

/** What clients may send, held to the configured limits, and where they connect. */
const configuration = (
    ctx: Context,
    limits: AboutSettings["limits"],
    media: MediaLimits,
): Instance["configuration"] => ({
    urls: { streaming: ctx.urls.origin.replace(/^http/, "ws") },
    // Push, featured tags and polls arrive in later steps.
    vapid: { public_key: "" },
    accounts: {
        max_featured_tags: 0,
        max_pinned_statuses: 0,
        max_display_name_length: limits.display_name,
        max_note_length: limits.note,
        max_profile_fields: limits.fields,
        profile_field_name_limit: limits.field_name,
        profile_field_value_limit: limits.field_value,
    },
    statuses: {
        max_characters: limits.status,
        max_media_attachments: limits.attachments,
        characters_reserved_per_url: charactersPerLink,
    },
    // Any other file is taken too, as a file, but clients offer only what is listed.
    media_attachments: {
        supported_mime_types: Object.values(imageFormats).map((format) => format.mediaType),
        image_size_limit: media.max_upload_bytes,
        image_matrix_limit: media.max_pixels,
        video_size_limit: 0,
        video_frame_rate_limit: 0,
        video_matrix_limit: 0,
    },
    polls: {
        max_options: 0,
        max_characters_per_option: 0,
        min_expiration: 0,
        max_expiration: 0,
    },
    translation: { enabled: false },
});

/** How many people, statuses and other instances the instance has, as it tells clients. */
export type InstanceStats = {
    /** Accounts that logged in in the last 30 days. */
    readonly activeMonth: number;
    readonly users: number;
    readonly statuses: number;
    /** Other instances it knows of. */
    readonly domains: number;
};

/** The instance's stats now. They take a few queries, so the routes keep them for a while. */
export const instanceStats = async (ctx: Context): Promise<InstanceStats> => ({
    activeMonth: await countAccountsWithTokensSince(
        ctx,
        new Date(ctx.clock.now().getTime() - activeWindowMs),
    ),
    users: await countLocalAccounts(ctx),
    statuses: await countLocalStatuses(ctx),
    domains: await countInstances(ctx),
});

/** The instance as Mastodon's API describes it, claiming Mastodon 4.3. */
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
        thumbnail: { url: ctx.urls.url`/instance/thumbnail.png` },
        icon: [],
        languages: [],
        configuration: configuration(ctx, limits, settings.media),
        // Accounts are made by logging in, never by a client's sign-up form.
        registrations: {
            enabled: false,
            approval_required: false,
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

/** The instance as Mastodon described it before 4.0, from how it describes itself now. */
export const renderV1Instance = (instance: Instance, stats: InstanceStats): V1Instance => ({
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
        media_attachments: instance.configuration.media_attachments,
        polls: instance.configuration.polls,
    },
    contact_account: instance.contact.account,
    rules: instance.rules,
});

type Document = NonNullable<AboutSettings["instance"]["privacy_policy"]>;

/** A configured text, such as the privacy policy, as HTML with the time it changed. */
export const renderDocument = (document: Document | undefined): ExtendedDescription => {
    if (!document) throw new NotFound();

    return { updated_at: document.updated.toISOString(), content: textToHtml(document.text) };
};

/** The terms of service, in force from their date. Only one version is kept. */
export const renderTerms = (ctx: Context, terms: Document | undefined): TermsOfService => {
    if (!terms) throw new NotFound();

    return {
        effective_date: terms.updated.toISOString().slice(0, 10),
        effective: terms.updated <= ctx.clock.now(),
        content: textToHtml(terms.text),
        succeeded_by: null,
    };
};
