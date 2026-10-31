import { Conversation } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { conversationPage, deleteConversation, markConversation } from "./conversation_queries.ts";
import { renderConversation, renderConversations } from "./render.ts";

const ConversationId = z.object({
    id: z.string().meta({ description: "The ID of the Conversation in the database." }),
});

const write = { require: "user", scope: "write:conversations", permission: "read:note" } as const;

const docs = "https://docs.joinmastodon.org/methods/conversations";

export const conversationRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/conversations",
        summary: "View all conversations",
        docs: `${docs}/#get`,
        tags: ["conversations"],
        auth: { require: "user", scope: "read:statuses", permission: "read:note" },
        query: PageQuery({ default: 20, max: 40 }),
        responses: { 200: Paged(Conversation) },
        handler: async (ctx, { query, viewer }) => {
            const rows = await conversationPage(ctx, viewer.accountId, query);

            return {
                status: 200,
                body: await renderConversations(ctx, rows, viewer.accountId),
                cursors: cursorsOf(rows, query, (row) => row.last_note_id),
            };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/conversations/:id",
        summary: "Remove a conversation",
        description: "Removes a conversation from your list of conversations.",
        docs: `${docs}/#delete`,
        tags: ["conversations"],
        auth: write,
        params: ConversationId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await deleteConversation(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/conversations/:id/read",
        summary: "Mark a conversation as read",
        docs: `${docs}/#read`,
        tags: ["conversations"],
        auth: write,
        params: ConversationId,
        responses: { 200: Conversation },
        handler: async (ctx, { params, viewer }) => {
            const row = await markConversation(ctx, viewer.accountId, params.id, false);
            if (row === undefined) throw new NotFound();

            return { status: 200, body: await renderConversation(ctx, row) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v1/conversations/:id/unread",
        summary: "Mark a conversation as unread",
        description: "Marks a conversation as unread, as if someone else posted in it again.",
        tags: ["conversations"],
        auth: write,
        params: ConversationId,
        responses: { 200: Conversation },
        handler: async (ctx, { params, viewer }) => {
            const row = await markConversation(ctx, viewer.accountId, params.id, true);
            if (row === undefined) throw new NotFound();

            return { status: 200, body: await renderConversation(ctx, row) };
        },
    }),
];
