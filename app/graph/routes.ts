import { Account, Relationship } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Flag, Text } from "../http/schemas.ts";
import { accountNoteLimit, noteAccount } from "./account_notes.ts";
import { followPage, type FollowSide } from "./follow_queries.ts";
import { acceptFollow, follow, rejectFollow, unfollow } from "./follows.ts";
import { blockRoutes } from "./block_routes.ts";
import { relationship, relationships } from "./relationships.ts";

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
 * Who follows, blocks and mutes whom. Before the account routes, whose `/api/v1/accounts/:id` would
 * take these.
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
    ...blockRoutes,
    noteRoute,
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/relationships",
        summary: "How the viewer is connected to each of some accounts",
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
