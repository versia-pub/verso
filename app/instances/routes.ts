import { Instance } from "@versia/client-api";
import denoConfig from "../../deno.json" with { type: "json" };
import { countActiveAccounts, findLocalAccount } from "../accounts/accounts.ts";
import { identiconBanner } from "../accounts/identicon.ts";
import { renderAccount } from "../accounts/render.ts";
import { rolesOf } from "../accounts/roles.ts";
import { escapeHtml } from "../accounts/text.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";

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
        rules: instance.rules.map((rule, index) => ({
            id: String(index + 1),
            text: rule.text,
            hint: rule.hint,
        })),
    };
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
    defineRoute({
        method: "GET",
        path: "/instance/thumbnail.png",
        summary: "The instance's picture, drawn from its domain",
        tags: ["instance"],
        maxAge: 24 * 60 * 60,
        responses: { 200: Binary("image/png") },
        handler: async (ctx) => ({ status: 200, file: await identiconBanner(domainOf(ctx)) }),
    }),
];
