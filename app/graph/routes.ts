import { Account, MutedAccount, Relationship } from "@versia/client-api";
import { canonicalizeDomain } from "@versia/protocol";
import { z } from "zod";
import { existingAccountIds, findAccount } from "../accounts/account_queries.ts";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Text } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { accountNotesOn } from "./account_note_queries.ts";
import { accountNoteLimit, noteAccount } from "./account_notes.ts";
import { blockPage, blocksBetween } from "./block_queries.ts";
import { block, unblock } from "./blocks.ts";
import { domainBlockedAmong, domainBlockPage } from "./domain_block_queries.ts";
import { blockDomainFor, unblockDomainFor } from "./domain_blocks.ts";
import { followPage, followsFrom, type FollowSide, followsOf } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";
import { mutePage, mutesOf } from "./mute_queries.ts";
import { mute, unmute } from "./mutes.ts";
import { renderRelationship } from "./render.ts";

/** A viewer acting for a user. */
type UserViewer = RouteViewer & { readonly accountId: string };

/**
 * How the viewer is connected to each of `ids` that is an account, in the order asked. Only a
 * viewer whose role lets them see everyone's blocks is shown who blocks them; to others, no one
 * does, so a block can't be found out.
 */
const relationships = async (ctx: Context, viewer: UserViewer, ids: readonly string[]) => {
    const viewerId = viewer.accountId;
    const asked = [...new Set(ids)];
    const known = new Set(await existingAccountIds(ctx, asked));
    const outgoing = new Map(
        (await followsFrom(ctx, viewerId, asked)).map((row) => [row.followee_id, row]),
    );
    const incoming = new Map(
        (await followsOf(ctx, viewerId, asked)).map((row) => [row.follower_id, row]),
    );
    const { blocking, blockedBy } = await blocksBetween(ctx, viewerId, asked);
    const seesBlocks = (await viewer.permissions()).has("blocks");
    const domainBlocked = await domainBlockedAmong(ctx, viewerId, asked);
    const mutes = await mutesOf(ctx, viewerId, asked);
    const notes = await accountNotesOn(ctx, viewerId, asked);

    return asked.filter((id) => known.has(id))
        .map((id) =>
            renderRelationship(
                id,
                outgoing.get(id),
                incoming.get(id),
                {
                    blocking: blocking.has(id),
                    blockedBy: seesBlocks && blockedBy.has(id),
                    domainBlocking: domainBlocked.has(id),
                },
                mutes.get(id),
                notes.get(id) ?? "",
            )
        );
};

/** The viewer's relationship with one account. */
const relationship = async (ctx: Context, viewer: UserViewer, id: string) => {
    const [found] = await relationships(ctx, viewer, [id]);
    if (found === undefined) throw new NotFound();
    return found;
};

/**
 * How a follower wants to see an account. Options left out stay as they were, and an empty list of
 * languages means all of them.
 * @see https://docs.joinmastodon.org/methods/accounts/#follow
 */
const FollowOptions = z.object({
    reblogs: Flag.optional(),
    notify: Flag.optional(),
    languages: z.array(z.string().regex(/^[a-z]{2}$/)).optional(),
});

/** An account's followers or follows, which an account that hides them shows only to itself. */
const followList = (side: FollowSide) =>
    defineRoute({
        method: "GET",
        path: `/api/v1/accounts/:id/${side}`,
        summary: side === "followers"
            ? "The accounts following an account, newest first"
            : "The accounts an account follows, newest first",
        tags: ["accounts"],
        auth: { require: "optional", scope: "read:accounts", permission: "read:account_follows" },
        params: z.object({ id: z.string() }),
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            const account = await findAccount(ctx, params.id);
            if (account === undefined) throw new NotFound();
            if (account.hide_collections && viewer?.accountId !== account.id) {
                return { status: 200, body: [], cursors: {} };
            }

            const follows = await followPage(ctx, side, account.id, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, follows.map((follow) => follow.account_id)),
                cursors: cursorsOf(follows, query, (follow) => follow.id),
            };
        },
    });

/** Accepts or rejects an account's request to follow the viewer. */
const answerRequest = (answer: "authorize" | "reject") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/follow_requests/:id/${answer}`,
        summary: answer === "authorize"
            ? "Accepts an account's request to follow the viewer"
            : "Rejects an account's request to follow the viewer",
        tags: ["follow_requests"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: z.object({ id: z.string() }),
        responses: { 200: Relationship },
        handler: async (ctx, { params, viewer }) => {
            const answered = answer === "authorize"
                ? await acceptFollow(ctx, params.id, viewer.accountId)
                : await rejectFollow(ctx, params.id, viewer.accountId, false);
            if (!answered) throw new NotFound();

            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    });

/** Blocks or unblocks an account. */
const blockRoute = (action: "block" | "unblock") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/accounts/:id/${action}`,
        ...action === "block"
            ? {
                summary: "Block account",
                description: "Block the given account. Clients should filter statuses from this " +
                    "account if received (e.g. due to a boost in the Home timeline).\n\n" +
                    "Unlike Mastodon, Verso tells neither the account nor its instance, and " +
                    "blocking ends no follows.",
            }
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
 * How the viewer mutes an account, as Mastodon takes it.
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
        "this account, if received (e.g. due to a boost in the Home timeline).\n\nMuting an " +
        "account already muted changes how it is muted. Durations are at most five years.",
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
 * What the viewer notes about an account, as Mastodon takes it.
 * @see https://docs.joinmastodon.org/methods/accounts/#note
 */
const AccountNoteBody = z.object({
    comment: Text(accountNoteLimit).default("").meta({
        description: "The comment to be set on that user. Provide an empty string or leave out " +
            "this parameter to clear the currently set note.",
    }),
});

/** Sets or clears what the viewer notes about an account. */
const noteRoute = defineRoute({
    method: "POST",
    path: "/api/v1/accounts/:id/note",
    summary: "Set private note on profile",
    description: "Sets a private note on a user.\n\nAs on Mastodon, a note is at most " +
        `${accountNoteLimit} characters.`,
    docs: "https://docs.joinmastodon.org/methods/accounts/#note",
    tags: ["accounts"],
    auth: { require: "user", scope: "write:accounts", permission: "owner:account" },
    params: z.object({ id: z.string() }),
    body: AccountNoteBody,
    responses: { 200: Relationship },
    handler: async (ctx, { params, body, viewer }) => {
        if (!await noteAccount(ctx, viewer.accountId, params.id, body.comment)) {
            throw new NotFound();
        }

        return { status: 200, body: await relationship(ctx, viewer, params.id) };
    },
});

/**
 * The domain the viewer blocks or unblocks, as Mastodon takes it, in any form a domain name can be
 * written in, such as with capitals.
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
    description: "Block a domain to change interactions with that domain's server.\n\nUnlike " +
        "Mastodon, Verso tells no one, keeps the viewer's followers there, and lets its users " +
        "still follow them. Instead, it blocks each account on the domain, and on its " +
        "subdomains, as blocking the account would. The domain must be a domain name.",
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

/** Stops blocking a domain for the viewer. */
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

/** Stops muting an account. */
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

/**
 * Who follows, blocks and mutes whom. Before the account routes, whose `/api/v1/accounts/:id` would take
 * these.
 */
export const graphRoutes: readonly Route[] = [
    followList("followers"),
    followList("following"),
    defineRoute({
        method: "GET",
        path: "/api/v1/follow_requests",
        summary: "The accounts asking to follow the viewer, newest first",
        tags: ["follow_requests"],
        auth: { require: "user", scope: "read:follows" },
        query: PageQuery({ default: 40, max: 80 }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { query, viewer }) => {
            const requests = await followPage(ctx, "requests", viewer.accountId, query);
            return {
                status: 200,
                body: await publicAccounts(ctx, requests.map((request) => request.account_id)),
                cursors: cursorsOf(requests, query, (request) => request.id),
            };
        },
    }),
    answerRequest("authorize"),
    answerRequest("reject"),
    blockRoute("block"),
    blockRoute("unblock"),
    muteRoute,
    unmuteRoute,
    noteRoute,
    blockDomainRoute,
    unblockDomainRoute,
    defineRoute({
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
    }),
    defineRoute({
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
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/blocks",
        summary: "View blocked users",
        description: "View your blocks. See also accounts/:id/{block,unblock}",
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
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/relationships",
        summary: "How the viewer is connected to each of some accounts",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:follows" },
        // `id[]=1&id[]=2`, or a single `id=1`.
        query: z.object({
            id: z.union([z.string().transform((id) => [id]), z.array(z.string())]).default([]),
        }),
        responses: { 200: z.array(Relationship) },
        handler: async (ctx, { query, viewer }) => ({
            status: 200,
            body: await relationships(ctx, viewer, query.id),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/accounts/:id/follow",
        summary: "Follows an account, or asks to, or changes how the viewer sees one they follow",
        tags: ["accounts"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: z.object({ id: z.string() }),
        body: FollowOptions,
        responses: { 200: Relationship },
        handler: async (ctx, { params, body, viewer }) => {
            const result = await follow(ctx, viewer.accountId, params.id, {
                showReblogs: body.reblogs,
                notify: body.notify,
                languages: body.languages && (body.languages.length > 0 ? body.languages : null),
            });

            if (result === "missing") throw new NotFound();
            if (result === "blocked") throw new NotPermitted("Its instance is blocked");

            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/accounts/:id/unfollow",
        summary: "Stops following an account, or withdraws asking to",
        tags: ["accounts"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: z.object({ id: z.string() }),
        responses: { 200: Relationship },
        handler: async (ctx, { params, viewer }) => {
            await unfollow(ctx, viewer.accountId, params.id);
            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/accounts/:id/remove_from_followers",
        summary: "Removes an account from the viewer's followers",
        tags: ["accounts"],
        auth: { require: "user", scope: "write:follows", permission: "owner:follow" },
        params: z.object({ id: z.string() }),
        responses: { 200: Relationship },
        handler: async (ctx, { params, viewer }) => {
            await rejectFollow(ctx, params.id, viewer.accountId, true);
            return { status: 200, body: await relationship(ctx, viewer, params.id) };
        },
    }),
];
