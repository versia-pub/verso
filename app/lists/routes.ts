import { Account, List } from "@versia/client-api";
import { z } from "zod";
import { findAccount } from "../accounts/account_queries.ts";
import { publicAccounts } from "../accounts/public.ts";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Ids, Integer, Text } from "../http/schemas.ts";
import {
    deleteList,
    findList,
    listAccountPage,
    listsOf,
    listsWith,
    updateList,
} from "./list_queries.ts";
import { addListAccounts, createList, removeListAccounts } from "./lists.ts";
import { renderList } from "./render.ts";
import { repliesPolicies } from "./tables.ts";

/** The longest title a list may have. Mastodon has no limit. */
const titleLimit = 256;

/** The most accounts one request may add to a list or remove from it. */
const membersLimit = 100;

const ListId = z.object({ id: z.string().meta({ description: "The ID of the list." }) });

const Title = Text(titleLimit).refine((title) => title.trim() !== "", {
    error: "Title can't be blank",
});

const RepliesPolicy = z.enum(repliesPolicies).meta({
    description: "One of `followed`, `list`, or `none`. Defaults to `list`.",
});

const Exclusive = Flag.meta({
    description: "Whether members of this list need to get removed from the “Home” feed.",
});

const AccountIds = Ids(membersLimit).default([]);

const auth = {
    read: { require: "user", scope: "read:lists", permission: "owner:list" },
    write: { require: "user", scope: "write:lists", permission: "owner:list" },
} as const;

const docs = "https://docs.joinmastodon.org/methods/lists";

export const listRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/lists",
        summary: "View your lists",
        description: "Fetch all lists that the user owns.",
        docs: `${docs}/#get`,
        tags: ["lists"],
        auth: auth.read,
        responses: { 200: z.array(List) },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: (await listsOf(ctx, viewer.accountId)).map(renderList),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/lists/:id",
        summary: "Show a single list",
        description: "Fetch the list with the given ID.",
        docs: `${docs}/#get-one`,
        tags: ["lists"],
        auth: auth.read,
        params: ListId,
        responses: { 200: List },
        handler: async (ctx, { params, viewer }) => {
            const list = await findList(ctx, viewer.accountId, params.id);
            if (list === undefined) throw new NotFound();

            return { status: 200, body: renderList(list) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/lists",
        summary: "Create a list",
        description: "Create a new list.",
        docs: `${docs}/#create`,
        tags: ["lists"],
        auth: auth.write,
        body: z.object({
            title: Title.meta({ description: "The title of the list to be created." }),
            replies_policy: RepliesPolicy.default("list"),
            exclusive: Exclusive.default(false),
        }),
        responses: { 200: List },
        handler: async (ctx, { body, viewer }) => {
            const list = await createList(ctx, viewer.accountId, body);
            if (list === "full") {
                throw new Unprocessable("You have reached the maximum number of lists");
            }

            return { status: 200, body: renderList(list) };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/lists/:id",
        summary: "Update a list",
        description: "Change the properties of a list.",
        docs: `${docs}/#update`,
        tags: ["lists"],
        auth: auth.write,
        params: ListId,
        body: z.object({
            title: Title.optional().meta({ description: "The title of the list to be created." }),
            replies_policy: RepliesPolicy.optional(),
            exclusive: Exclusive.optional(),
        }),
        responses: { 200: List },
        handler: async (ctx, { body, params, viewer }) => {
            const list = await updateList(ctx, viewer.accountId, params.id, body);
            if (list === undefined) throw new NotFound();

            return { status: 200, body: renderList(list) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/lists/:id",
        summary: "Delete a list",
        docs: `${docs}/#delete`,
        tags: ["lists"],
        auth: auth.write,
        params: ListId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await deleteList(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/lists/:id/accounts",
        summary: "View accounts in a list",
        docs: `${docs}/#accounts`,
        tags: ["lists"],
        auth: auth.read,
        params: ListId,
        query: PageQuery({ default: 40, max: 80 }).extend({
            limit: Integer.pipe(z.int().min(0)).optional().meta({
                description: "Maximum number of results. Defaults to 40 accounts. Max 80 " +
                    "accounts. Set to 0 in order to get all accounts without pagination.",
            }),
        }),
        responses: { 200: Paged(Account) },
        handler: async (ctx, { params, query, viewer }) => {
            if (await findList(ctx, viewer.accountId, params.id) === undefined) {
                throw new NotFound();
            }

            // A limit of 0 asks for every account, on one page with no links.
            const page = query.limit === 0
                ? null
                : { ...query, limit: Math.min(query.limit ?? 40, 80) };
            const members = await listAccountPage(ctx, params.id, page);

            return {
                status: 200,
                body: await publicAccounts(ctx, members.map((row) => row.account_id)),
                cursors: page === null ? {} : cursorsOf(members, page, (row) => row.id),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/lists/:id/accounts",
        summary: "Add accounts to a list",
        description: "Add accounts to the given list. Note that the user must be following " +
            "these accounts.",
        docs: `${docs}/#accounts-add`,
        tags: ["lists"],
        auth: auth.write,
        params: ListId,
        body: z.object({
            account_ids: AccountIds.meta({
                description: "The accounts that should be added to the list.",
            }),
        }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { body, params, viewer }) => {
            const result = await addListAccounts(
                ctx,
                viewer.accountId,
                params.id,
                body.account_ids,
            );
            if (result === "no_list" || result === "missing") throw new NotFound();
            if (result === "unfollowed") {
                throw new Unprocessable("Account follow relationship missing");
            }
            if (result === "taken") throw new Unprocessable("Account has already been taken");

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/lists/:id/accounts",
        summary: "Remove accounts from list",
        description: "Remove accounts from the given list.",
        docs: `${docs}/#accounts-remove`,
        tags: ["lists"],
        auth: auth.write,
        params: ListId,
        // Mastodon's web app sends them in the query, other apps in the body.
        query: z.object({ account_ids: AccountIds }),
        body: z.object({
            account_ids: AccountIds.meta({
                description: "The accounts that should be removed from the list.",
            }),
        }),
        responses: { 200: z.object({}) },
        handler: async (ctx, { body, params, query, viewer }) => {
            const accountIds = [...new Set([...query.account_ids, ...body.account_ids])];
            if (!await removeListAccounts(ctx, viewer.accountId, params.id, accountIds)) {
                throw new NotFound();
            }

            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id/lists",
        summary: "Get lists containing this account",
        description: "User lists that you have added this account to.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#lists",
        tags: ["accounts"],
        auth: auth.read,
        params: z.object({ id: z.string().meta({ description: "The ID of the account." }) }),
        responses: { 200: z.array(List) },
        handler: async (ctx, { params, viewer }) => {
            if (await findAccount(ctx, params.id) === undefined) throw new NotFound();

            return {
                status: 200,
                body: (await listsWith(ctx, viewer.accountId, params.id)).map(renderList),
            };
        },
    }),
];
