import { Account, FamiliarFollowers, Relationship } from "@versia/client-api";
import { z } from "zod";
import { findAccount, findAccounts } from "../accounts/account_queries.ts";
import { publicAccounts, publicAccountsOf } from "../accounts/public.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import type { Context } from "../kernel/context.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Paged } from "../http/responses.ts";
import { Flag, Ids, Text } from "../http/schemas.ts";
import { accountNoteLimit, noteAccount } from "./account_notes.ts";
import { familiarFollows, followPage, type FollowSide } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";
import { blockRoutes } from "./block_routes.ts";
import { relationship, relationships } from "./relationships.ts";

/**
 * How a follower wants to see an account. Omitted options stay as they were, and an empty list of
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
        ...side === "followers"
            ? {
                summary: "Get account's followers",
                description:
                    "Accounts which follow the given account, if network is not hidden by the " +
                    "account owner.",
                docs: "https://docs.joinmastodon.org/methods/accounts/#followers",
            }
            : {
                summary: "Get account's following",
                description:
                    "Accounts which the given account is following, if network is not hidden " +
                    "by the account owner.",
                docs: "https://docs.joinmastodon.org/methods/accounts/#following",
            },
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

/** Accepts or rejects an account's follow request to the viewer. */
const answerRequest = (answer: "authorize" | "reject") =>
    defineRoute({
        method: "POST",
        path: `/api/v1/follow_requests/:id/${answer}`,
        ...answer === "authorize"
            ? {
                summary: "Accept follow request",
                docs: "https://docs.joinmastodon.org/methods/follow_requests/#accept",
            }
            : {
                summary: "Reject follow request",
                docs: "https://docs.joinmastodon.org/methods/follow_requests/#reject",
            },
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

/**
 * What the viewer notes about an account, as Mastodon accepts it.
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
    description: "Sets a private note on a user.",
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

/** For each of `accountIds` that exists, the accounts `viewerId` follows that follow it. */
const familiarFollowers = async (
    ctx: Context,
    viewerId: string,
    accountIds: readonly string[],
): Promise<FamiliarFollowers[]> => {
    const accounts = new Map((await findAccounts(ctx, accountIds)).map((row) => [row.id, row]));
    const follows = await familiarFollows(ctx, viewerId, accountIds);
    const followers = await publicAccountsOf(
        ctx,
        await findAccounts(ctx, [...new Set(follows.map((follow) => follow.follower_id))]),
    );

    return accountIds.flatMap((id) => {
        const account = accounts.get(id);
        if (account === undefined) return [];
        // As its followers are hidden, so is which of them the viewer follows.
        if (account.hide_collections) return [{ id, accounts: [] }];

        return [{
            id,
            accounts: follows.filter((follow) => follow.followee_id === id)
                .flatMap((follow) => followers.get(follow.follower_id) ?? []),
        }];
    });
};

/**
 * Who follows, blocks and mutes whom. Before the account routes, whose `/api/v1/accounts/:id` would
 * otherwise match these paths.
 */
export const graphRoutes: readonly Route[] = [
    followList("followers"),
    followList("following"),
    defineRoute({
        method: "GET",
        path: "/api/v1/follow_requests",
        summary: "View pending follow requests",
        docs: "https://docs.joinmastodon.org/methods/follow_requests/#get",
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
    ...blockRoutes,
    noteRoute,
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/relationships",
        summary: "Check relationships to other accounts",
        description: "Find out whether a given account is followed, blocked, muted, etc.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#relationships",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:follows" },
        // `id[]=1&id[]=2`, or a single `id=1`. Each id costs queries, so there are at most as many
        // as the longest page of accounts.
        query: z.object({
            id: z.union([z.string().transform((id) => [id]), z.array(z.string())]).default([])
                .pipe(z.array(z.string()).max(80, { error: "Must be at most 80 ids" })),
        }),
        responses: { 200: z.array(Relationship) },
        handler: async (ctx, { query, viewer }) => ({
            status: 200,
            body: await relationships(ctx, viewer, query.id),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/familiar_followers",
        summary: "Find familiar followers",
        description:
            "Obtain a list of all accounts that follow a given account, filtered for accounts you follow.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#familiar_followers",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:follows", permission: "read:account_follows" },
        query: z.object({
            id: Ids(80).default([]).meta({
                description: "Find familiar followers for the provided account IDs.",
            }),
        }),
        responses: { 200: z.array(FamiliarFollowers) },
        handler: async (ctx, { query, viewer }) => ({
            status: 200,
            body: await familiarFollowers(ctx, viewer.accountId, query.id),
        }),
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/accounts/:id/follow",
        summary: "Follow account",
        description:
            "Follow the given account. Can also be used to update whether to show reblogs or " +
            "enable notifications.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#follow",
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
        summary: "Unfollow account",
        description: "Unfollow the given account.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#unfollow",
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
        summary: "Remove account from followers",
        description: "Remove the given account from your followers.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#remove_from_followers",
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
