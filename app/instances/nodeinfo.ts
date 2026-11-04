/**
 * NodeInfo, the small description of an instance that directories and statistics sites read, as
 * Mastodon serves it: a discovery document and the 2.0 schema it points to.
 * @see https://nodeinfo.diaspora.software/protocol.html
 * @module
 */
import { z } from "zod";
import denoConfig from "../../deno.json" with { type: "json" };
import { countLocalAccounts, countLocalStatuses } from "../accounts/account_queries.ts";
import { countAccountsWithTokensSince } from "../auth/token_queries.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { cached } from "../kernel/cache.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";

const weekMs = 7 * 24 * 60 * 60 * 1000;

/** How long the discovery document may be cached, as Mastodon says: it never changes. */
const discoverySeconds = 3 * 24 * 60 * 60;

/** How long the schema and the counts in it may be cached, as Mastodon says. */
const schemaSeconds = 30 * 60;

/** The schema version this document follows, and the relation that points to it. */
const schemaVersion = "2.0" as const;
const schemaRel = `http://nodeinfo.diaspora.software/ns/schema/${schemaVersion}`;

/** Where a client finds the schemas an instance has. */
const Discovery = z.object({
    links: z.array(z.object({ rel: z.string(), href: z.url() })),
});

/** The numbers NodeInfo reports about an instance. */
type Counts = {
    readonly total: number;
    readonly activeMonth: number;
    readonly activeHalfyear: number;
    readonly localPosts: number;
};

/** NodeInfo 2.0, with the fields Mastodon fills in. */
const NodeInfo = z.object({
    version: z.literal(schemaVersion),
    software: z.object({ name: z.string(), version: z.string() }),
    protocols: z.array(z.string()),
    services: z.object({ outbound: z.array(z.string()), inbound: z.array(z.string()) }),
    usage: z.object({
        users: z.object({
            total: z.number(),
            activeMonth: z.number(),
            activeHalfyear: z.number(),
        }),
        localPosts: z.number(),
    }),
    openRegistrations: z.boolean(),
    metadata: z.object({ nodeName: z.string(), nodeDescription: z.string() }),
});

/** How many people use the instance, as Mastodon counts: logins show who was active. */
const countUsage = async (ctx: Context): Promise<Counts> => {
    const now = ctx.clock.now().getTime();

    return {
        total: await countLocalAccounts(ctx),
        activeMonth: await countAccountsWithTokensSince(ctx, new Date(now - 4 * weekMs)),
        activeHalfyear: await countAccountsWithTokensSince(ctx, new Date(now - 24 * weekMs)),
        localPosts: await countLocalStatuses(ctx),
    };
};

/**
 * `/.well-known/nodeinfo` and the document it points to. Anyone may read them. They are as
 * Mastodon's, apart from the software and its protocol: Verso federates over Versia, which NodeInfo
 * has no name for, so it says `versia`, as Versia Server does. Nobody can sign up, as the instance
 * API says, so registrations are never open.
 */
export const nodeInfoRoutes = (instance: Config["instance"]): readonly Route[] => {
    const counts = cached(schemaSeconds * 1000, countUsage);

    return [
        defineRoute({
            method: "GET",
            path: "/.well-known/nodeinfo",
            summary: "Discover NodeInfo",
            tags: ["versia"],
            maxAge: discoverySeconds,
            responses: { 200: Discovery },
            handler: (ctx) =>
                Promise.resolve({
                    status: 200,
                    body: {
                        links: [{ rel: schemaRel, href: ctx.urls.url`/nodeinfo/${schemaVersion}` }],
                    },
                }),
        }),
        defineRoute({
            method: "GET",
            path: `/nodeinfo/${schemaVersion}`,
            summary: "Get NodeInfo",
            tags: ["versia"],
            maxAge: schemaSeconds,
            responses: { 200: NodeInfo },
            handler: async (ctx) => {
                const usage = await counts.get(ctx);

                return {
                    status: 200,
                    body: {
                        version: schemaVersion,
                        software: { name: "verso", version: denoConfig.version },
                        protocols: ["versia"],
                        services: { outbound: [], inbound: [] },
                        usage: {
                            users: {
                                total: usage.total,
                                activeMonth: usage.activeMonth,
                                activeHalfyear: usage.activeHalfyear,
                            },
                            localPosts: usage.localPosts,
                        },
                        openRegistrations: false,
                        metadata: {
                            nodeName: instance.name ?? ctx.urls.domain,
                            nodeDescription: instance.description,
                        },
                    },
                };
            },
        }),
    ];
};
