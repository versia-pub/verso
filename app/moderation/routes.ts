import { DomainBlock } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import type { Config } from "../kernel/config.ts";
import { allDomainBlocks } from "./domain_blocks.ts";

/** Who config shows something to, `"none"`, `"users"` or `"all"`. */
type Audience = Config["instance"]["show_blocks"];

/** Whether `audience` includes the caller, signed in as a user or not. */
const shownTo = (audience: Audience, signedIn: boolean) =>
    audience === "all" || (audience === "users" && signedIn);

/** The instance's blocked domains, to whoever config shows them to. */
export const moderationRoutes = (
    instance: Pick<Config["instance"], "show_blocks" | "show_block_reasons">,
    blockedDomains: readonly string[],
): readonly Route[] => [
    defineRoute({
        method: "GET",
        path: "/api/v1/instance/domain_blocks",
        summary: "View moderated servers",
        description: "Obtain a list of domains that have been blocked.",
        docs: "https://docs.joinmastodon.org/methods/instance/#domain_blocks",
        tags: ["instance"],
        auth: { require: "optional" },
        responses: { 200: z.array(DomainBlock) },
        handler: async (ctx, { viewer }) => {
            const signedIn = typeof viewer?.accountId === "string";
            if (!shownTo(instance.show_blocks, signedIn)) throw new NotFound();

            const withReasons = shownTo(instance.show_block_reasons, signedIn);
            const blocks = await allDomainBlocks(ctx, blockedDomains);

            return {
                status: 200,
                body: await Promise.all(blocks.map(async ({ domain, reason }) => ({
                    domain,
                    digest: new Uint8Array(
                        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)),
                    ).toHex(),
                    severity: "suspend" as const,
                    comment: withReasons && reason !== "" ? reason : null,
                }))),
            };
        },
    }),
];
