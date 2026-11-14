import { v0_7 } from "@versia/protocol";
import denoConfig from "../../deno.json" with { type: "json" };
import { staffWith } from "../accounts/role_queries.ts";
import { firstMigratedAt } from "../db/migrate.ts";
import { CollectionPage } from "../federation/registry.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { versiaJson } from "../http/responses.ts";
import type { Config } from "../kernel/config.ts";
import type { Permission } from "../kernel/permissions.ts";

/** Listed whatever the registry has, since the social entities are core to Verso. */
const alwaysSupported = "pub.versia:social";

/** Every extension Verso supports is at version 1. */
const extensionVersion = 1;

/**
 * A route for the collection of the instance's staff with `permission`, as the spec's
 * `admins` and `moderators`. Local users who are suspended or deleted aren't listed.
 * @see https://versia.pub/federation/endpoints#instance-collections
 */
const staffRoute = (name: string, permission: Permission, description: string): Route =>
    defineRoute({
        method: "GET",
        path: `/.versia/v0.7/instance/collections/${name}`,
        summary: `Get the ${name} of the instance`,
        description,
        tags: ["versia"],
        signed: true,
        contentType: versiaJson,
        query: CollectionPage,
        responses: { 200: v0_7.ReferenceCollection },
        handler: async (ctx, { query }) => {
            const { total, ids } = await staffWith(ctx, permission, query);
            const items = ids.map((id) => v0_7.formatReference({ host: ctx.urls.domain, id }));

            return { status: 200, body: { total, items } };
        },
    });

/**
 * How remote instances find out about this one: which versions of Versia it speaks, then what it
 * says about itself, then its staff. The first two aren't signed, since a peer reads them to learn
 * the key to validate signatures with.
 * @see https://versia.pub/federation/discovery
 */
export const versiaInstanceRoutes = (
    instance: Config["instance"],
    extensions: readonly string[],
): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/.well-known/versia",
        summary: "List Versia versions",
        tags: ["versia"],
        // As the spec's example responses.
        contentType: "application/jrd+json",
        responses: { 200: v0_7.WellKnown },
        handler: () => Promise.resolve({ status: 200, body: { versions: ["0.7.0"] } }),
    }),
    defineRoute({
        method: "GET",
        path: "/.versia/v0.7/instance",
        summary: "Get Versia instance metadata",
        tags: ["versia"],
        contentType: versiaJson,
        responses: { 200: v0_7.InstanceMetadata },
        handler: async (ctx) => {
            const domain = ctx.urls.domain;
            const metadata: v0_7.InstanceMetadata = {
                type: "InstanceMetadata",
                created_at: (await firstMigratedAt(ctx.db)).toISOString(),
                name: instance.name ?? domain,
                software: { name: "Verso", version: denoConfig.version },
                compatibility: {
                    extensions: [...new Set([...extensions, alwaysSupported])].toSorted()
                        .map((name) => `${name}@${extensionVersion}`),
                },
                description: instance.description === "" ? undefined : instance.description,
                domain,
                public_key: {
                    algorithm: "ed25519",
                    key: (await ctx.federation.instanceKey(ctx)).publicKey,
                },
            };

            return { status: 200, body: metadata };
        },
    }),
    staffRoute("admins", "roles", "The local users who can manage roles."),
    staffRoute("moderators", "reports", "The local users who can handle reports."),
];
