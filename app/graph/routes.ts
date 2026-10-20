import { Account, Relationship } from "@versia/client-api";
import { z } from "zod";
import { existingAccountIds, findAccount } from "../accounts/accounts.ts";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { defineRoute, Paged, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { followPage, followsFrom, type FollowSide, followsOf } from "./follow_queries.ts";
import { follow, unfollow } from "./follows.ts";
import { renderRelationship } from "./render.ts";

/** How `viewerId` is connected to each of `ids` that is an account, in the order asked. */
const relationships = async (ctx: Context, viewerId: string, ids: readonly string[]) => {
    const asked = [...new Set(ids)];
    const known = new Set(await existingAccountIds(ctx, asked));
    const outgoing = new Map(
        (await followsFrom(ctx, viewerId, asked)).map((row) => [row.followee_id, row]),
    );
    const incoming = new Map(
        (await followsOf(ctx, viewerId, asked)).map((row) => [row.follower_id, row]),
    );

    return asked.filter((id) => known.has(id))
        .map((id) => renderRelationship(id, outgoing.get(id), incoming.get(id)));
};

/** The viewer's relationship with one account. */
const relationship = async (ctx: Context, viewerId: string, id: string) => {
    const [found] = await relationships(ctx, viewerId, [id]);
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

/** Who follows whom. Before the account routes, whose `/api/v1/accounts/:id` would take these. */
export const graphRoutes: readonly Route[] = [
    followList("followers"),
    followList("following"),
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
            body: await relationships(ctx, viewer.accountId, query.id),
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

            return { status: 200, body: await relationship(ctx, viewer.accountId, params.id) };
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
            return { status: 200, body: await relationship(ctx, viewer.accountId, params.id) };
        },
    }),
];
