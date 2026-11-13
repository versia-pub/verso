/**
 * Moderating accounts, for moderators with the `accounts` permission.
 * @see https://docs.joinmastodon.org/methods/admin/accounts/
 * @module
 */
import { AdminAccount } from "@versia/client-api";
import { z } from "zod";
import {
    type AdminAccountFilter,
    adminAccountPage,
    findAccount,
} from "../accounts/account_queries.ts";
import { renderAdminAccountRows } from "../accounts/admin_render.ts";
import { listRoles } from "../accounts/role_queries.ts";
import { NotFound, NotPermitted } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Strings } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { actOnAccount, type Moderated, queueModeratedDeletion } from "./account_actions.ts";
import { unsilence } from "./silences.ts";
import { unsuspend } from "./suspensions.ts";

const docs = "https://docs.joinmastodon.org/methods/admin/accounts";

const Id = z.object({ id: z.string() });

const read = { require: "user", scope: "admin:read:accounts", permission: "accounts" } as const;
const write = { require: "user", scope: "admin:write:accounts", permission: "accounts" } as const;

/** The roles Mastodon counts as staff: those that may deal with reports. */
const staffRoleIds = async (ctx: Context): Promise<string[]> =>
    (await listRoles(ctx)).filter((role) => role.permissions.includes("reports"))
        .map((role) => role.id);

/** Throws for an action that was refused. */
const orRefusal = (result: Moderated): void => {
    if (result.ok) return;

    if (result.reason === "not-found") throw new NotFound();
    throw new NotPermitted(result.description);
};

const Status = z.enum(["active", "pending", "disabled", "silenced", "suspended", "sensitized"]);

/** The v1 query's status flags. Mastodon lets the later one win when several are given. */
const v1Statuses = ["active", "pending", "disabled", "silenced", "suspended"] as const;

/** The admin API's account routes, which show what `permissions.default` lets every user do. */
export const adminAccountRoutes = (settings: {
    readonly permissions: Pick<Config["permissions"], "default">;
}): readonly Route[] => {
    const everyUser = settings.permissions.default;

    /** The account `id` as moderators see it, or a 404. */
    const shown = async (ctx: Context, id: string) => {
        const row = await findAccount(ctx, id);
        if (row === undefined) throw new NotFound();

        const [account] = await renderAdminAccountRows(ctx, [row], everyUser);

        return account;
    };

    /** A page of the accounts `filter` matches, as moderators see them. */
    const page = async (
        ctx: Context,
        filter: AdminAccountFilter,
        query: z.output<ReturnType<typeof PageQuery>>,
    ) => {
        const rows = await adminAccountPage(ctx, filter, query);

        return {
            status: 200 as const,
            body: await renderAdminAccountRows(ctx, rows, everyUser),
            cursors: cursorsOf(rows, query, (row) => row.id),
        };
    };

    return [
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/accounts",
            summary: "View accounts (v1)",
            description: "View all accounts, optionally matching certain criteria for filtering, " +
                "up to 100 at a time. Pagination may be done with the HTTP Link header in the " +
                "response.",
            docs: `${docs}/#v1`,
            tags: ["admin"],
            auth: read,
            query: PageQuery({ default: 100, max: 200 }).extend({
                local: Flag.default(false),
                remote: Flag.default(false),
                by_domain: z.string().optional(),
                active: Flag.default(false),
                pending: Flag.default(false),
                disabled: Flag.default(false),
                sensitized: Flag.default(false),
                silenced: Flag.default(false),
                suspended: Flag.default(false),
                username: z.string().optional(),
                display_name: z.string().optional(),
                email: z.string().optional(),
                ip: z.string().optional(),
                staff: Flag.default(false),
            }),
            responses: { 200: Paged(AdminAccount) },
            handler: async (ctx, { query }) =>
                await page(ctx, {
                    origin: query.remote ? "remote" : "local",
                    status: v1Statuses.findLast((status) => query[status]) ?? "active",
                    username: query.username?.trim().replace(/^@/, ""),
                    displayName: query.display_name?.trim(),
                    domain: query.by_domain,
                    roleIds: query.staff ? await staffRoleIds(ctx) : undefined,
                    untracked: query.email !== undefined || query.ip !== undefined,
                }, query),
        }),
        defineRoute({
            method: "GET",
            path: "/api/v2/admin/accounts",
            summary: "View accounts (v2)",
            description: "View all accounts, optionally matching certain criteria for filtering, " +
                "up to 100 at a time. Pagination may be done with the HTTP Link header in the " +
                "response.",
            docs: `${docs}/#v2`,
            tags: ["admin"],
            auth: read,
            query: PageQuery({ default: 100, max: 200 }).extend({
                origin: z.enum(["local", "remote"]).optional(),
                status: Status.optional(),
                permissions: z.string().optional(),
                role_ids: Strings.optional(),
                invited_by: z.string().optional(),
                username: z.string().optional(),
                display_name: z.string().optional(),
                by_domain: z.string().optional(),
                email: z.string().optional(),
                ip: z.string().optional(),
            }),
            responses: { 200: Paged(AdminAccount) },
            handler: async (ctx, { query }) =>
                await page(ctx, {
                    origin: query.origin,
                    status: query.status,
                    username: query.username?.trim().replace(/^@/, ""),
                    displayName: query.display_name?.trim(),
                    domain: query.by_domain,
                    roleIds: query.permissions === "staff"
                        ? await staffRoleIds(ctx)
                        : query.role_ids,
                    untracked: [query.invited_by, query.email, query.ip]
                        .some((value) => value !== undefined),
                }, query),
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/accounts/:id",
            summary: "View a specific account",
            description: "View admin-level information about the given account.",
            docs: `${docs}/#get-one`,
            tags: ["admin"],
            auth: read,
            params: Id,
            responses: { 200: AdminAccount },
            handler: async (ctx, { params }) => ({
                status: 200,
                body: await shown(ctx, params.id),
            }),
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/accounts/:id/action",
            summary: "Perform an action against an account",
            description: "Perform an action against an account and log this action in the " +
                "moderation history. Also resolves any open reports against this account.",
            docs: `${docs}/#action`,
            tags: ["admin"],
            auth: write,
            params: Id,
            body: z.object({
                type: z.enum(["silence", "suspend"]),
                report_id: z.string().optional(),
                warning_preset_id: z.string().optional(),
                text: z.string().optional(),
                send_email_notification: Flag.optional(),
            }),
            responses: { 200: z.strictObject({}) },
            handler: async (ctx, { params, body, viewer }) => {
                const moderator = {
                    accountId: viewer.accountId,
                    permissions: await viewer.permissions(),
                };
                orRefusal(
                    await actOnAccount(ctx, moderator, params.id, {
                        type: body.type,
                        reportId: body.report_id,
                    }),
                );

                return { status: 200, body: {} };
            },
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/accounts/:id/unsilence",
            summary: "Unsilence an account",
            description: "Unsilence an account if it is currently silenced.",
            docs: `${docs}/#unsilence`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: AdminAccount },
            handler: async (ctx, { params }) => {
                await unsilence(ctx, params.id);

                return { status: 200, body: await shown(ctx, params.id) };
            },
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/accounts/:id/unsuspend",
            summary: "Unsuspend an account",
            description: "Unsuspend a currently suspended account.",
            docs: `${docs}/#unsuspend`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: AdminAccount },
            handler: async (ctx, { params }) => {
                const row = await findAccount(ctx, params.id);
                if (row === undefined) throw new NotFound();
                if (row.deleted_at !== null) {
                    throw new NotPermitted("Deleted accounts can't be unsuspended");
                }

                await unsuspend(ctx, params.id);

                return { status: 200, body: await shown(ctx, params.id) };
            },
        }),
        defineRoute({
            method: "DELETE",
            path: "/api/v1/admin/accounts/:id",
            summary: "Delete an account",
            description: "Permanently delete data for a suspended account.",
            docs: `${docs}/#delete`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: z.strictObject({}) },
            handler: async (ctx, { params, viewer }) => {
                const moderator = {
                    accountId: viewer.accountId,
                    permissions: await viewer.permissions(),
                };
                orRefusal(await queueModeratedDeletion(ctx, moderator, params.id));

                return { status: 200, body: {} };
            },
        }),
    ];
};
