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
import { identiconBanner } from "../accounts/identicon.ts";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import {
    type AboutSettings,
    renderDocument,
    renderInstance,
    renderRules,
    renderTerms,
    renderV1Instance,
} from "./render.ts";

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
            file: await (drawn ??= identiconBanner(ctx.urls.domain)),
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
