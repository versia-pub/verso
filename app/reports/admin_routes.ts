/**
 * Dealing with reports, for moderators with the `reports` permission.
 * @see https://docs.joinmastodon.org/methods/admin/reports/
 * @module
 */
import { AdminReport } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { renderRules } from "../instances/render.ts";
import { renderAdminReports } from "./admin_render.ts";
import {
    findReport,
    reopenReport,
    type ReportFilter,
    reportPage,
    type ReportRow,
    resolveReportBy,
} from "./report_queries.ts";

const docs = "https://docs.joinmastodon.org/methods/admin/reports";

const Id = z.object({ id: z.string() });

const read = { require: "user", scope: "admin:read:reports", permission: "reports" } as const;
const write = { require: "user", scope: "admin:write:reports", permission: "reports" } as const;

/**
 * Which reports to list for the `resolved` and `unresolved` flags: all if both are set, resolved
 * if only that one is, and unresolved otherwise.
 */
const stateOf = (resolved: boolean, unresolved: boolean): ReportFilter["state"] =>
    resolved ? (unresolved ? "all" : "resolved") : "unresolved";

/** The reports routes of the admin API, with the rules in `instance` that reports may name. */
export const adminReportRoutes = (settings: {
    readonly instance: Pick<Config["instance"], "rules">;
    readonly permissions: Pick<Config["permissions"], "default">;
}): readonly Route[] => {
    const rules = renderRules(settings.instance);
    const render = async (ctx: Context, viewerId: string, row: ReportRow) => {
        const [report] = await renderAdminReports(
            ctx,
            [row],
            viewerId,
            rules,
            settings.permissions.default,
        );
        return report;
    };

    return [
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/reports",
            summary: "View all reports",
            description: "View all reports. Pagination may be done with HTTP Link header in the " +
                "response.",
            docs: `${docs}/#get`,
            tags: ["admin"],
            auth: read,
            query: PageQuery({ default: 100, max: 200 }).extend({
                resolved: Flag.default(false),
                unresolved: Flag.default(false),
                account_id: z.string().optional(),
                target_account_id: z.string().optional(),
            }),
            responses: { 200: Paged(AdminReport) },
            handler: async (ctx, { query, viewer }) => {
                const rows = await reportPage(ctx, {
                    state: stateOf(query.resolved, query.unresolved),
                    accountId: query.account_id,
                    targetAccountId: query.target_account_id,
                }, query);

                return {
                    status: 200,
                    body: await renderAdminReports(
                        ctx,
                        rows,
                        viewer.accountId,
                        rules,
                        settings.permissions.default,
                    ),
                    cursors: cursorsOf(rows, query, (row) => row.id),
                };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/reports/:id",
            summary: "View a single report",
            description: "View information about the report with the given ID.",
            docs: `${docs}/#get-one`,
            tags: ["admin"],
            auth: read,
            params: Id,
            responses: { 200: AdminReport },
            handler: async (ctx, { params, viewer }) => {
                const row = await findReport(ctx, params.id);
                if (row === undefined) throw new NotFound();

                return { status: 200, body: await render(ctx, viewer.accountId, row) };
            },
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/reports/:id/resolve",
            summary: "Mark report as resolved",
            description: "Mark a report as resolved with no further action taken.",
            docs: `${docs}/#resolve`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: AdminReport },
            handler: async (ctx, { params, viewer }) => {
                const row = await resolveReportBy(
                    ctx,
                    params.id,
                    viewer.accountId,
                    ctx.clock.now(),
                );
                if (row === undefined) throw new NotFound();

                return { status: 200, body: await render(ctx, viewer.accountId, row) };
            },
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/reports/:id/reopen",
            summary: "Re-open a closed report",
            description: "Reopen a currently closed report, if it is closed.",
            docs: `${docs}/#reopen`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: AdminReport },
            handler: async (ctx, { params, viewer }) => {
                const row = await reopenReport(ctx, params.id, ctx.clock.now());
                if (row === undefined) throw new NotFound();

                return { status: 200, body: await render(ctx, viewer.accountId, row) };
            },
        }),
    ];
};
