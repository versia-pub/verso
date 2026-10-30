import { publicAccounts } from "../accounts/public.ts";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Paged } from "../http/responses.ts";
import { Flag } from "../http/schemas.ts";
import { blockPage } from "./block_queries.ts";
import { block, unblock } from "./blocks.ts";
import { domainBlockPage } from "./domain_block_queries.ts";
import { blockDomainFor, unblockDomainFor } from "./domain_blocks.ts";
import { mutePage } from "./mute_queries.ts";
import { mute, unmute } from "./mutes.ts";
import { relationship } from "./relationships.ts";
import { Account, MutedAccount, Relationship } from "@versia/client-api";
import { canonicalizeDomain } from "@versia/protocol";
import { z } from "zod";

/** Blocks or unblocks an account. */
const blockRoute = (action: "block" | "unblock") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/accounts/:id/${action}`,
        ...action === "block"
            ? { summary: "Block account", description: "Blocks the given account." }
            : { summary: "Unblock account", description: "Unblock the given account." },
        docs: `https://docs.joinmastodon.org/methods/accounts/#${action}`,
        tags: ["accounts"],
        auth: { require: "user", scope: "write:blocks", permission: "owner:block" },
        params: z.object({ id: z.string() }),
        responses: { 200: Relationship },
        handler: async (ctx, { params, viewer }) => {
            if (action === "block" && !await block(ctx, viewer.accountId, params.id)) {
                throw new NotFound();
            }
            if (action === "unblock") await unblock(ctx, viewer.accountId, params.id);

            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    });

/** The longest a mute may last, as on Versia Server: five years, in seconds. */
const longestMute = 5 * 365 * 24 * 60 * 60;

/**
 * How the viewer mutes an account, as Mastodon accepts it.
 * @see https://docs.joinmastodon.org/methods/accounts/#mute
 */
const MuteBody = z.object({
    notifications: Flag.default(true).meta({
        description: "Mute notifications in addition to statuses? Defaults to true.",
    }),
    duration: z.coerce.number().int().min(0).max(longestMute).default(0).meta({
        description: "How long the mute should last, in seconds. Defaults to 0 (indefinite).",
    }),
});

/** Mutes an account, or changes how the viewer mutes it. */
const muteRoute = defineRoute({
    method: "POST",
    path: "/api/v1/accounts/:id/mute",
    summary: "Mute account",
    description: "Mute the given account. Clients should filter statuses and notifications from " +
        "this account, if received (e.g. due to a boost in the Home timeline).",
    docs: "https://docs.joinmastodon.org/methods/accounts/#mute",
    tags: ["accounts"],
    auth: { require: "user", scope: "write:mutes", permission: "owner:mute" },
    params: z.object({ id: z.string() }),
    body: MuteBody,
    responses: { 200: Relationship },
    handler: async (ctx, { params, body, viewer }) => {
        if (!await mute(ctx, viewer.accountId, params.id, body)) throw new NotFound();

        return { status: 200, body: await relationship(ctx, viewer, params.id) };
    },
});

/**
 * The domain the viewer blocks or unblocks, as Mastodon accepts it, in any form a domain name can
 * be written in, such as with capitals.
 * @see https://docs.joinmastodon.org/methods/domain_blocks/
 */
const DomainBody = (description: string) =>
    z.object({
        domain: z.string().transform((domain, issues) => {
            const canonical = canonicalizeDomain(domain);
            if (canonical === undefined) {
                issues.addIssue({ code: "custom", message: "Must be a domain name" });
            }
            return canonical ?? domain;
        }).meta({ description }),
    });

/** Blocks a domain for the viewer. */
const blockDomainRoute = defineRoute({
    method: "POST",
    path: "/api/v1/domain_blocks",
    summary: "Block a domain",
    description: "Block a domain to change interactions with that domain's server.",
    docs: "https://docs.joinmastodon.org/methods/domain_blocks/#block",
    tags: ["domain_blocks"],
    auth: { require: "user", scope: "write:blocks", permission: "owner:block" },
    body: DomainBody("Domain to block."),
    responses: { 200: z.object({}) },
    handler: async (ctx, { body, viewer }) => {
        await blockDomainFor(ctx, viewer.accountId, body.domain);
        return { status: 200, body: {} };
    },
});

/** Unblocks a domain for the viewer. */
const unblockDomainRoute = defineRoute({
    method: "DELETE",
    path: "/api/v1/domain_blocks",
    summary: "Unblock a domain",
    description: "Remove a domain block, if it exists in the user's array of blocked domains.",
    docs: "https://docs.joinmastodon.org/methods/domain_blocks/#unblock",
    tags: ["domain_blocks"],
    auth: { require: "user", scope: "write:blocks", permission: "owner:block" },
    body: DomainBody("Domain to unblock."),
    responses: { 200: z.object({}) },
    handler: async (ctx, { body, viewer }) => {
        await unblockDomainFor(ctx, viewer.accountId, body.domain);
        return { status: 200, body: {} };
    },
});

/** Unmutes an account. */
const unmuteRoute = defineRoute({
    method: "POST",
    path: "/api/v1/accounts/:id/unmute",
    summary: "Unmute account",
    description: "Unmute the given account.",
    docs: "https://docs.joinmastodon.org/methods/accounts/#unmute",
    tags: ["accounts"],
    auth: { require: "user", scope: "write:mutes", permission: "owner:mute" },
    params: z.object({ id: z.string() }),
    responses: { 200: Relationship },
    handler: async (ctx, { params, viewer }) => {
        await unmute(ctx, viewer.accountId, params.id);

        return { status: 200, body: await relationship(ctx, viewer, params.id) };
    },
});

/** The domains the viewer blocks, newest first. */
const domainBlockList = defineRoute({
    method: "GET",
    path: "/api/v1/domain_blocks",
    summary: "Get domain blocks",
    description: "View domains the user has blocked.",
    docs: "https://docs.joinmastodon.org/methods/domain_blocks/#get",
    tags: ["domain_blocks"],
    auth: { require: "user", scope: "read:blocks", permission: "owner:block" },
    query: PageQuery({ default: 100, max: 200 }),
    responses: { 200: Paged(z.string()) },
    handler: async (ctx, { query, viewer }) => {
        const blocks = await domainBlockPage(ctx, viewer.accountId, query);
        return {
            status: 200,
            body: blocks.map((each) => each.domain),
            cursors: cursorsOf(blocks, query, (each) => each.id),
        };
    },
});

/** The accounts the viewer mutes, newest first. */
const muteList = defineRoute({
    method: "GET",
    path: "/api/v1/mutes",
    summary: "View muted accounts",
    description: "Accounts the user has muted.",
    docs: "https://docs.joinmastodon.org/methods/mutes/#get",
    tags: ["mutes"],
    auth: { require: "user", scope: "read:mutes", permission: "owner:mute" },
    query: PageQuery({ default: 40, max: 80 }),
    responses: { 200: Paged(MutedAccount) },
    handler: async (ctx, { query, viewer }) => {
        const mutes = await mutePage(ctx, viewer.accountId, query);
        const ends = new Map(mutes.map((each) => [each.account_id, each.expires_at]));
        const accounts = await publicAccounts(ctx, [...ends.keys()]);
        return {
            status: 200,
            body: accounts.map((account) => ({
                ...account,
                mute_expires_at: ends.get(account.id)?.toISOString() ?? null,
            })),
            cursors: cursorsOf(mutes, query, (each) => each.id),
        };
    },
});

/** The accounts the viewer blocks, newest first. */
const blockList = defineRoute({
    method: "GET",
    path: "/api/v1/blocks",
    summary: "View blocked users",
    description: "Returns your blocked accounts.",
    docs: "https://docs.joinmastodon.org/methods/blocks/#get",
    tags: ["blocks"],
    auth: { require: "user", scope: "read:blocks", permission: "owner:block" },
    query: PageQuery({ default: 40, max: 80 }),
    responses: { 200: Paged(Account) },
    handler: async (ctx, { query, viewer }) => {
        const blocks = await blockPage(ctx, viewer.accountId, query);
        return {
            status: 200,
            body: await publicAccounts(ctx, blocks.map((block) => block.account_id)),
            cursors: cursorsOf(blocks, query, (block) => block.id),
        };
    },
});

/** Blocks, mutes and domain blocks, and the lists of them. */
export const blockRoutes: readonly Route[] = [
    blockRoute("block"),
    blockRoute("unblock"),
    muteRoute,
    unmuteRoute,
    blockDomainRoute,
    unblockDomainRoute,
    domainBlockList,
    muteList,
    blockList,
];
