import { v0_6 } from "@versia/protocol";
import { z } from "zod";
import denoConfig from "../../deno.json" with { type: "json" };
import { firstMigratedAt } from "../db/migrate.ts";
import { defineRoute, type Route, versiaJson } from "../http/route.ts";
import type { Config } from "../kernel/config.ts";

/**
 * How other instances find out about this one: which versions of Versia it speaks, then what it
 * says about itself. Neither is signed, since a peer reads them to learn the key to check
 * signatures with.
 * @see https://versia.pub/federation/discovery
 */
export const versiaInstanceRoutes = (
    instance: Config["instance"],
    extensions: readonly string[],
): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/.well-known/versia",
        summary: "The versions of Versia the instance speaks",
        tags: ["versia"],
        // As the spec's example answers.
        contentType: "application/jrd+json",
        responses: { 200: z.object({ versions: z.array(z.string()) }) },
        handler: () => Promise.resolve({ status: 200, body: { versions: ["0.6.0"] } }),
    }),
    defineRoute({
        method: "GET",
        path: "/.versia/v0.6/instance",
        summary: "What the instance says about itself, with its public key",
        tags: ["versia"],
        contentType: versiaJson,
        responses: { 200: v0_6.InstanceMetadata },
        handler: async (ctx) => {
            const domain = ctx.urls.domain;
            const metadata: v0_6.InstanceMetadata = {
                type: "InstanceMetadata",
                created_at: (await firstMigratedAt(ctx.db)).toISOString(),
                name: instance.name ?? domain,
                software: { name: "Verso", version: denoConfig.version },
                compatibility: { versions: ["0.6.0"], extensions: [...extensions] },
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
];
