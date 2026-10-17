import {
    CustomEmoji,
    ExtendedDescription,
    Instance,
    PrivacyPolicy,
    Rule,
    TermsOfService,
    V1Instance,
} from "@versia/client-api";
import { z } from "zod";
import denoConfig from "../../deno.json" with { type: "json" };
import { countActiveAccounts, countLocalAccounts, findLocalAccount } from "../accounts/accounts.ts";
import { identiconBanner } from "../accounts/identicon.ts";
import { renderAccount } from "../accounts/render.ts";
import { rolesOf } from "../accounts/roles.ts";
import { escapeHtml, textToHtml } from "../accounts/text.ts";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { countInstances } from "./instances.ts";

/** What the instance's description is made from. */
export type AboutSettings = Pick<Config, "instance" | "limits" | "auth">;

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

const domainOf = (ctx: Context) => new URL(ctx.urls.origin).hostname;

/** The contact account, if config names a local account that exists. */
const contactAccount = async (ctx: Context, username: string | undefined) => {
    const row = username === undefined ? undefined : await findLocalAccount(ctx, username);
    return row ? renderAccount(ctx, row, await rolesOf(ctx, row.id)) : null;
};

/** The rules, numbered from 1 in the order config lists them. */
const renderRules = (instance: AboutSettings["instance"]): Rule[] =>
    instance.rules.map((rule, index) => ({
        id: String(index + 1),
        text: rule.text,
        hint: rule.hint,
    }));

/** The instance as Mastodon's API describes it, claiming Mastodon 4.3. */
const renderInstance = async (ctx: Context, settings: AboutSettings): Promise<Instance> => {
    const { instance, limits } = settings;
    const domain = domainOf(ctx);
    const since = new Date(ctx.clock.now().getTime() - activeWindowMs);

    return {
        domain,
        title: instance.name ?? domain,
        version: `${mastodonVersion} (compatible; Verso ${denoConfig.version})`,
        source_url: sourceUrl,
        description: instance.description,
        usage: { users: { active_month: await countActiveAccounts(ctx, since) } },
        thumbnail: { url: ctx.urls.url`/instance/thumbnail.png` },
        icon: [],
        languages: [],
        configuration: {
            urls: { streaming: ctx.urls.origin.replace(/^http/, "ws") },
            // Push, pins, featured tags, statuses, media and polls arrive in later steps.
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
                max_characters: 0,
                max_media_attachments: 0,
                characters_reserved_per_url: 23,
            },
            media_attachments: {
                supported_mime_types: [],
                image_size_limit: 0,
                image_matrix_limit: 0,
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
        },
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
const renderV1Instance = async (ctx: Context, instance: Instance): Promise<V1Instance> => ({
    uri: instance.domain,
    title: instance.title,
    short_description: instance.description,
    description: textToHtml(instance.description),
    email: instance.contact.email,
    version: instance.version,
    urls: { streaming_api: instance.configuration.urls.streaming },
    stats: {
        user_count: await countLocalAccounts(ctx),
        // Statuses arrive in a later step.
        status_count: 0,
        domain_count: await countInstances(ctx),
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
const renderDocument = (document: Document | undefined): ExtendedDescription => {
    if (!document) throw new NotFound();

    return { updated_at: document.updated.toISOString(), content: textToHtml(document.text) };
};

/** The terms of service, in force from their date. Only one version is kept. */
const renderTerms = (ctx: Context, terms: Document | undefined): TermsOfService => {
    if (!terms) throw new NotFound();

    return {
        effective_date: terms.updated.toISOString().slice(0, 10),
        effective: terms.updated <= ctx.clock.now(),
        content: textToHtml(terms.text),
        succeeded_by: null,
    };
};

/** The instance's picture, drawn from its domain once, when first asked for. */
const thumbnailRoute = () => {
    let drawn: Promise<Uint8Array> | undefined;

    return defineRoute({
        method: "GET",
        path: "/instance/thumbnail.png",
        summary: "The instance's picture, drawn from its domain",
        tags: ["instance"],
        maxAge: 24 * 60 * 60,
        responses: { 200: Binary("image/png") },
        handler: async (ctx) => ({
            status: 200,
            file: await (drawn ??= identiconBanner(domainOf(ctx))),
        }),
    });
};

/** What the instance tells clients about itself. */
export const instanceRoutes = (settings: AboutSettings): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/api/v2/instance",
        summary: "The instance, its limits, and how to join and contact it",
        tags: ["instance"],
        responses: { 200: Instance },
        handler: async (ctx) => ({ status: 200, body: await renderInstance(ctx, settings) }),
    }),
    thumbnailRoute(),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance",
        summary: "The instance, as Mastodon described it before 4.0",
        tags: ["instance"],
        responses: { 200: V1Instance },
        handler: async (ctx) => ({
            status: 200,
            body: await renderV1Instance(ctx, await renderInstance(ctx, settings)),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/rules",
        summary: "What people agree to follow on the instance",
        tags: ["instance"],
        responses: { 200: z.array(Rule) },
        handler: () => Promise.resolve({ status: 200, body: renderRules(settings.instance) }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/extended_description",
        summary: "A longer text about the instance, for its about page",
        tags: ["instance"],
        responses: { 200: ExtendedDescription },
        handler: () =>
            Promise.resolve({
                status: 200,
                body: renderDocument(settings.instance.extended_description),
            }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/privacy_policy",
        summary: "The instance's privacy policy",
        tags: ["instance"],
        responses: { 200: PrivacyPolicy },
        handler: () =>
            Promise.resolve({
                status: 200,
                body: renderDocument(settings.instance.privacy_policy),
            }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/terms_of_service",
        summary: "The instance's terms of service",
        tags: ["instance"],
        responses: { 200: TermsOfService },
        handler: (ctx) =>
            Promise.resolve({
                status: 200,
                body: renderTerms(ctx, settings.instance.terms_of_service),
            }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/terms_of_service/:date",
        summary: "The instance's terms of service in force from a day",
        tags: ["instance"],
        params: z.object({ date: z.string() }),
        responses: { 200: TermsOfService },
        handler: (ctx, { params }) => {
            const terms = renderTerms(ctx, settings.instance.terms_of_service);
            if (terms.effective_date !== params.date) throw new NotFound();

            return Promise.resolve({ status: 200, body: terms });
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/custom_emojis",
        summary: "The instance's custom emojis",
        tags: ["instance"],
        responses: { 200: z.array(CustomEmoji) },
        // Custom emojis arrive in a later step.
        handler: () => Promise.resolve({ status: 200, body: [] }),
    }),
];
