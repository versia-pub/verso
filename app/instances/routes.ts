import {
    ExtendedDescription,
    Instance,
    Language,
    PrivacyPolicy,
    Rule,
    TermsOfService,
    V1Instance,
    WeeklyActivity,
} from "@versia/client-api";
import { z } from "zod";
import { identiconBanner } from "../accounts/identicon.ts";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Binary } from "../http/responses.ts";
import { cached } from "../kernel/cache.ts";
import { weeklyActivity } from "./activity.ts";
import { instanceDomains } from "./instance_queries.ts";
import { languages } from "./languages.ts";
import {
    type AboutSettings,
    instanceStats,
    renderDocument,
    renderInstance,
    renderRules,
    renderTerms,
    renderV1Instance,
} from "./render.ts";

/** The instance's picture, generated from its domain once, when first requested. */
const thumbnailRoute = () => {
    let drawn: Promise<Uint8Array> | undefined;

    return defineRoute({
        method: "GET",
        path: "/instance/thumbnail.png",
        summary: "Get instance thumbnail",
        tags: ["instance"],
        maxAge: 24 * 60 * 60,
        responses: { 200: Binary("image/png") },
        handler: async (ctx) => ({
            status: 200,
            file: await (drawn ??= identiconBanner(ctx.urls.domain)),
        }),
    });
};

/** How long the instance's stats are cached: clients request them each time they start. */
const statsMs = 5 * 60_000;

/** How long lists that change slowly may be cached, as Mastodon caches them. */
const daySeconds = 24 * 60 * 60;

/** What the instance tells clients about itself, with its stats cached for a while. */
export const instanceRoutes = (settings: AboutSettings): readonly Route[] => {
    const stats = cached(statsMs, instanceStats);
    const activity = cached(daySeconds * 1000, weeklyActivity);

    return [
        defineRoute({
            method: "GET",
            path: "/api/v2/instance",
            summary: "View server information",
            description: "Obtain general information about the server.",
            docs: "https://docs.joinmastodon.org/methods/instance/#v2",
            tags: ["instance"],
            responses: { 200: Instance },
            handler: async (ctx) => ({
                status: 200,
                body: await renderInstance(ctx, settings, await stats.get(ctx)),
            }),
        }),
        thumbnailRoute(),
        defineRoute({
            method: "GET",
            path: "/api/v1/instance",
            summary: "View server information (v1)",
            description: "Obtain general information about the server. See api/v2/instance " +
                "instead.",
            docs: "https://docs.joinmastodon.org/methods/instance/#v1",
            tags: ["instance"],
            responses: { 200: V1Instance },
            handler: async (ctx) => {
                const kept = await stats.get(ctx);
                return {
                    status: 200,
                    body: renderV1Instance(await renderInstance(ctx, settings, kept), kept),
                };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/instance/rules",
            summary: "List of rules",
            description: "Rules that the users of this service should follow.",
            docs: "https://docs.joinmastodon.org/methods/instance/#rules",
            tags: ["instance"],
            responses: { 200: z.array(Rule) },
            handler: () => Promise.resolve({ status: 200, body: renderRules(settings.instance) }),
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/instance/extended_description",
            summary: "View extended description",
            description: "Obtain an extended description of this server.",
            docs: "https://docs.joinmastodon.org/methods/instance/#extended_description",
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
            summary: "View privacy policy",
            description: "Obtain the contents of this server's privacy policy.",
            docs: "https://docs.joinmastodon.org/methods/instance/#privacy_policy",
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
            summary: "View terms of service",
            description: "Obtain the contents of this server's terms of service, if configured.",
            docs: "https://docs.joinmastodon.org/methods/instance/#terms_of_service",
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
            summary: "View a specific version of the terms of service",
            description: "Obtain the contents of this server's terms of service, for a specified " +
                "date, if configured.",
            docs: "https://docs.joinmastodon.org/methods/instance/#terms_of_service_date",
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
            path: "/api/v1/instance/peers",
            summary: "List of connected domains",
            description: "Domains that this server is aware of.",
            docs: "https://docs.joinmastodon.org/methods/instance/#peers",
            tags: ["instance"],
            maxAge: daySeconds,
            responses: { 200: z.array(z.string()) },
            handler: async (ctx) => {
                if (!settings.instance.show_peers) throw new NotFound();

                const domains = await instanceDomains(ctx);
                const blocked = await Promise.all(
                    domains.map((domain) => ctx.federation.isBlocked(ctx, domain)),
                );

                return { status: 200, body: domains.filter((_, index) => !blocked[index]) };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/instance/activity",
            summary: "Weekly activity",
            description: "Server activity over the last 3 months, binned weekly.",
            docs: "https://docs.joinmastodon.org/methods/instance/#activity",
            tags: ["instance"],
            maxAge: daySeconds,
            responses: { 200: z.array(WeeklyActivity) },
            handler: async (ctx) => {
                if (!settings.instance.show_activity) throw new NotFound();

                return { status: 200, body: await activity.get(ctx) };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/instance/languages",
            summary: "Supported languages",
            description: "Languages that statuses may be written in.",
            tags: ["instance"],
            maxAge: daySeconds,
            responses: { 200: z.array(Language) },
            handler: () => Promise.resolve({ status: 200, body: [...languages] }),
        }),
    ];
};
