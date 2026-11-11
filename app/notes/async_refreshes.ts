/**
 * Async refreshes: fetches a client can follow, here of the replies of a thread a user opened, as
 * Mastodon's are. The context response names one in its `Mastodon-Async-Refresh` header while it
 * runs, and the client asks how it is going until it is finished, then asks for the context again.
 * @see https://docs.joinmastodon.org/methods/async_refreshes/
 * @module
 */
import { AsyncRefresh } from "@versia/client-api";
import type { Selectable } from "kysely";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import type { AsyncRefreshesTable } from "./tables.ts";

/** How long a refresh is kept while it runs, in case its job never ends. */
const runningMs = 24 * 60 * 60_000;

/** How long a refresh is kept after it finished. */
const finishedMs = 60 * 60_000;

/** The refresh of the replies under the status `noteId`, one for every viewer. */
export const contextRefresh = (noteId: string): string => `context:${noteId}`;

/** A refresh, as stored. */
export type AsyncRefreshRow = Selectable<AsyncRefreshesTable>;

const expired = (ctx: Context, row: AsyncRefreshRow) =>
    ctx.clock.now().getTime() >=
        (row.finished_at === null
            ? row.started_at.getTime() + runningMs
            : row.finished_at.getTime() + finishedMs);

/** The refresh `id`, unless there is none, or it is no longer kept. */
const findRefresh = async (ctx: Context, id: string): Promise<AsyncRefreshRow | undefined> => {
    const row = await ctx.db.selectFrom("async_refreshes").selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

    return row === undefined || expired(ctx, row) ? undefined : row;
};

/** The refresh `id`, if it is running. */
export const runningRefresh = async (
    ctx: Context,
    id: string,
): Promise<AsyncRefreshRow | undefined> => {
    const row = await findRefresh(ctx, id);
    return row?.finished_at === null ? row : undefined;
};

/** Starts the refresh `id` over, as running with no results, and drops those no longer kept. */
export const startRefresh = async (ctx: Context, id: string): Promise<AsyncRefreshRow> => {
    const now = ctx.clock.now();
    await ctx.db.deleteFrom("async_refreshes")
        .where((eb) =>
            eb.or([
                eb.and([
                    eb("finished_at", "is", null),
                    eb("started_at", "<=", new Date(now.getTime() - runningMs)),
                ]),
                eb("finished_at", "<=", new Date(now.getTime() - finishedMs)),
            ])
        )
        .execute();

    const row = { id, started_at: now, finished_at: null, result_count: 0 };
    await ctx.db.insertInto("async_refreshes").values(row)
        .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
                started_at: now,
                finished_at: null,
                result_count: 0,
            })
        )
        .execute();
    return row;
};

/** Adds `count` new results to the refresh `id`, if there is one. */
export const countResults = async (ctx: Context, id: string, count: number): Promise<void> => {
    await ctx.db.updateTable("async_refreshes")
        .set((eb) => ({ result_count: eb("result_count", "+", count) }))
        .where("id", "=", id)
        .execute();
};

/** Marks the refresh `id` finished, if there is one. */
export const finishRefresh = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.updateTable("async_refreshes")
        .set({ finished_at: ctx.clock.now() })
        .where("id", "=", id)
        .where("finished_at", "is", null)
        .execute();
};

/** The `Mastodon-Async-Refresh` header naming `row`, which asks to check again in 3 seconds. */
export const refreshHeader = (row: AsyncRefreshRow): Record<string, string> => ({
    "mastodon-async-refresh": `id="${row.id}", retry=3, result_count=${row.result_count}`,
});

export const asyncRefreshRoutes: Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1_alpha/async_refreshes/:id",
        summary: "Get Status of Async Refresh",
        description:
            "Sometimes an API request might not return the expected results or not all possible results as either a background job is already running to (re-)create these results or the request triggers a background job to create or fetch results.",
        docs: "https://docs.joinmastodon.org/methods/async_refreshes/#show",
        tags: ["statuses"],
        auth: { require: "user", scope: "read", permission: "read:note" },
        params: z.object({ id: z.string() }),
        responses: { 200: z.object({ async_refresh: AsyncRefresh }) },
        handler: async (ctx, { params }) => {
            const row = await findRefresh(ctx, params.id);
            if (row === undefined) throw new NotFound();

            return {
                status: 200,
                body: {
                    async_refresh: {
                        id: row.id,
                        status: row.finished_at === null ? "running" as const : "finished" as const,
                        result_count: row.result_count,
                    },
                },
            };
        },
    }),
];
