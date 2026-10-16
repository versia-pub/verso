import { VersiaRole } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { findAccount } from "./accounts.ts";
import { findRoleById, listRoles, type RoleRow, rolesOf } from "./roles.ts";

const Id = z.object({ id: z.string() });

/** A role as Versia's role endpoints show it. */
export const renderVersiaRole = (role: RoleRow): VersiaRole => ({
    id: role.id,
    name: role.name,
    permissions: role.permissions,
    priority: role.priority,
    description: role.description,
    visible: role.visible,
    // Left out when there is none, as Versia Server does.
    icon: role.icon ?? undefined,
    color: role.color,
});

/** Versia Server's role endpoints, which any user may read. */
export const roleRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/roles",
        summary: "Every role, highest priority first",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        responses: { 200: z.array(VersiaRole) },
        handler: async (ctx) => ({
            status: 200,
            body: (await listRoles(ctx)).map(renderVersiaRole),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/roles/:id",
        summary: "A role",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        params: Id,
        responses: { 200: VersiaRole },
        handler: async (ctx, { params }) => {
            const role = await findRoleById(ctx, params.id);
            if (!role) throw new NotFound();

            return { status: 200, body: renderVersiaRole(role) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id/roles",
        summary: "An account's roles, highest priority first",
        tags: ["roles"],
        auth: { require: "user", scope: "read:accounts" },
        params: Id,
        responses: { 200: z.array(VersiaRole) },
        handler: async (ctx, { params }) => {
            // Remote accounts aren't shown yet, and have no roles here anyway.
            const account = await findAccount(ctx, params.id);
            if (account?.domain !== null) throw new NotFound();

            return { status: 200, body: (await rolesOf(ctx, account.id)).map(renderVersiaRole) };
        },
    }),
];
