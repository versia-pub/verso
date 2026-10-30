/**
 * The profile directory: the local accounts that agreed to be listed.
 * @see https://docs.joinmastodon.org/methods/directory/
 * @module
 */
import { Account } from "@versia/client-api";
import { z } from "zod";
import { blockerIdsQuery } from "../graph/block_queries.ts";
import { notExcluded } from "../graph/excluded_queries.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Integer } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import { publicAccounts } from "./public.ts";

/** Which page of the directory to list, and in what order. */
export type DirectoryPage = {
    /** Who is looking, if anyone is signed in. */
    readonly viewerId: string | null;
    /** `active` lists those who posted most recently first, and `new` the newest accounts. */
    readonly order: "active" | "new";
    readonly limit: number;
    readonly offset: number;
};

/**
 * The ids of the local discoverable accounts on `page`. A viewer doesn't see the accounts they
 * block or mute, or those that block them.
 */
export const directoryIds = async (ctx: Context, page: DirectoryPage): Promise<string[]> => {
    let query = ctx.db.selectFrom("accounts")
        .select("accounts.id")
        .where("accounts.instance_id", "is", null)
        .where("accounts.discoverable", "=", true);

    if (page.viewerId !== null) {
        query = query
            .where(notExcluded(hiddenFrom(ctx, page.viewerId), "accounts.id"))
            .where("accounts.id", "not in", blockerIdsQuery(ctx, page.viewerId));
    }

    if (page.order === "active") {
        query = query.orderBy("accounts.last_status_at", (order) => order.desc().nullsLast());
    }

    const rows = await query
        .orderBy("accounts.created_at", "desc")
        .orderBy("accounts.id", "desc")
        .limit(page.limit)
        .offset(page.offset)
        .execute();

    return rows.map((row) => row.id);
};

export const directoryRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/directory",
        summary: "View profile directory",
        description: "List accounts visible in the directory.",
        docs: "https://docs.joinmastodon.org/methods/directory/#get",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        query: z.object({
            offset: Integer.pipe(z.int().min(0)).default(0).meta({
                description: "Skip the first n results.",
            }),
            limit: Integer.pipe(z.int().min(0)).optional()
                .transform((asked) => Math.max(1, Math.min(asked ?? 40, 80)))
                .meta({
                    description: "How many accounts to load. Defaults to 40 accounts. Max 80 " +
                        "accounts.",
                }),
            order: z.enum(["active", "new"]).default("active").meta({
                description: "Use `active` to sort by most recently posted statuses (default) or " +
                    "`new` to sort by most recently created profiles.",
            }),
            local: Flag.default(false).meta({
                description: "If true, returns only local accounts.",
            }),
        }),
        responses: { 200: z.array(Account) },
        handler: async (ctx, { query, viewer }) => {
            const viewerId = typeof viewer?.accountId === "string" ? viewer.accountId : null;
            const ids = await directoryIds(ctx, { viewerId, ...query });

            return { status: 200, body: await publicAccounts(ctx, ids) };
        },
    }),
];
